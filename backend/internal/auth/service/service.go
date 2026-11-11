package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	userservice "github.com/Koshsky/erp-backend/internal/user/service"

	"github.com/Koshsky/erp-backend/internal/auth/dto"
	repo "github.com/Koshsky/erp-backend/internal/auth/repository"
	"github.com/Koshsky/erp-backend/internal/auth/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/security/hasher"
	"github.com/Koshsky/erp-backend/internal/security/jwt"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userDTO "github.com/Koshsky/erp-backend/internal/user/dto"
)

// activeSessionSweepWindow — how long expired sessions are kept before background cleanup.
const activeSessionSweepWindow = 30 * 24 * time.Hour

// sessionSweepInterval — how often the background expired-session sweep runs.
const sessionSweepInterval = 1 * time.Hour

// reuseGraceWindow — a rotated-away refresh token presented again within this
// window is treated as a benign concurrent duplicate (a client retry racing
// its own successful refresh), not as token theft. After the window expires
// the pre-existing theft reaction (whole-family revocation) applies, so a
// genuinely stolen token cannot extend sessions forever.
const reuseGraceWindow = 60 * time.Second

// refreshChainMaxHops bounds following the replaced_by chain. Chains are
// acyclic by construction (new session ids grow monotonically); the bound is a
// defensive guard against corrupted data.
const refreshChainMaxHops = 10

type AuthService struct {
	logger   *slog.Logger
	users    UserService
	jwt      *jwt.Service
	sessions SessionRepository
	tracer   *tracingpkg.Tracer

	// cleanupOnce guarantees the expired-session sweep loop starts at most once
	// (on the first auth call, see startSweep).
	cleanupOnce sync.Once
}

// NewAuthService builds the auth service.
func NewAuthService(
	logger *slog.Logger,
	users *userservice.UserService,
	jwtService *jwt.Service,
	sessions *repo.AuthRepository,
	tracer *tracingpkg.Tracer,
) *AuthService {
	return &AuthService{
		logger:   logger.With("component", "auth_service"),
		users:    users,
		jwt:      jwtService,
		sessions: sessions,
		tracer:   tracer,
	}
}

func (s *AuthService) Login(ctx context.Context, username, password string) (*dto.SessionResult, error) {
	ctx, end := s.tracer.Start(ctx, "auth.Login")
	defer end(nil)
	s.startSweep()

	// Logins are stored lowercase; normalize the input so case-insensitive
	// login matches the stored value without leaking case sensitivity.
	username = strings.ToLower(strings.TrimSpace(username))

	user, err := s.users.FindUserByUsername(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("invalid credentials")
	}

	if err = hasher.Compare(user.PasswordHash, password); err != nil {
		return nil, fmt.Errorf("invalid credentials")
	}

	refresh, err := s.issueSession(ctx, user.ID, 0)
	if err != nil {
		return nil, err
	}

	access, err := s.jwt.GenerateAccessToken(user.ID, user.Username)
	if err != nil {
		return nil, fmt.Errorf("failed to generate access token")
	}

	return &dto.SessionResult{
		Auth:         s.newAuthResponse(user, access),
		RefreshToken: refresh,
	}, nil
}

func (s *AuthService) RefreshToken(ctx context.Context, refreshToken string) (*dto.SessionResult, error) {
	ctx, end := s.tracer.Start(ctx, "auth.RefreshToken")
	defer end(nil)
	s.startSweep()

	session, err := s.findSession(ctx, refreshToken)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	if session.RevokedAt.Valid && !s.isBenignReuse(ctx, session, now) {
		// The token was already rotated away and the reuse is NOT a benign
		// concurrent duplicate: it is older than the grace window or its
		// replaced_by chain no longer resolves to a live session. That
		// indicates theft: revoke all of the user's active sessions. The
		// failure is logged loudly — a failed revocation must never be
		// silently swallowed, and no new pair is issued either (a still-valid
		// stolen token would otherwise keep rotating).
		if rerr := s.sessions.RevokeAllUserSessions(ctx, session.UserID); rerr != nil {
			s.logger.ErrorContext(ctx,
				"auth: не удалось отозвать сессии при повторном использовании токена",
				"user_id", session.UserID,
				"error", rerr,
			)
		}
		return nil, fmt.Errorf("invalid refresh token")
	}
	// A revoked token within the grace window is a benign concurrent duplicate
	// (a client retry racing its own successful refresh) and must not revoke
	// the family; its own expiry is irrelevant because it was rotated seconds
	// ago by definition. An unrevolved token must still be unexpired.
	if !session.RevokedAt.Valid && !session.ExpiresAt.After(now) {
		return nil, fmt.Errorf("invalid refresh token")
	}

	user, err := s.users.FindUserByID(ctx, session.UserID)
	if err != nil {
		return nil, fmt.Errorf("user not found")
	}

	predecessor := session.ID
	if session.RevokedAt.Valid {
		// Benign concurrent duplicate: re-issue a fresh pair in the same
		// family, chained to the rotated-away token like any rotation, so the
		// family keeps working on every leg of the race.
		s.logger.InfoContext(ctx,
			"auth: повторное использование refresh-токена в пределах grace-окна",
			"user_id", session.UserID,
			"session_id", session.ID,
		)
	} else {
		// Rotation: the old session is revoked and a new pair is issued,
		// chaining the new session to the rotated-away one via replaced_by.
		if err = s.sessions.RevokeSession(ctx, session.ID); err != nil {
			return nil, fmt.Errorf("failed to rotate session")
		}
	}
	return s.issuePair(ctx, user, predecessor)
}

// isBenignReuse reports whether presenting an already-rotated token is a
// benign concurrent duplicate: the token was rotated away within the grace
// window AND its replaced_by chain still resolves to a live session (i.e. it
// was replaced by a rotation, not merely revoked by logout or a revocation).
func (s *AuthService) isBenignReuse(ctx context.Context, presented sqlc.FindSessionByHashRow, now time.Time) bool {
	if presented.RevokedAt.Time.After(now) || now.Sub(presented.RevokedAt.Time) > reuseGraceWindow {
		return false
	}
	_, resolved := s.resolveChainHead(ctx, presented)
	return resolved
}

// resolveChainHead follows the replaced_by chain from a revoked session to the
// family's current live session. It reports whether the chain resolves, i.e.
// whether the presented token really was rotated away (as opposed to revoked
// without a successor).
func (s *AuthService) resolveChainHead(
	ctx context.Context,
	presented sqlc.FindSessionByHashRow,
) (sqlc.FindSessionByReplacedByRow, bool) {
	cur := sqlc.FindSessionByReplacedByRow(presented)
	for range refreshChainMaxHops {
		next, err := s.sessions.FindSessionByReplacedBy(ctx, cur.ID)
		if err != nil {
			return sqlc.FindSessionByReplacedByRow{}, false
		}
		if !next.RevokedAt.Valid {
			return next, true
		}
		cur = next
	}
	return sqlc.FindSessionByReplacedByRow{}, false
}

// Logout revokes the session by refresh token (idempotently).
func (s *AuthService) Logout(ctx context.Context, refreshToken string) error {
	ctx, end := s.tracer.Start(ctx, "auth.Logout")
	defer end(nil)
	s.startSweep()

	if refreshToken == "" {
		return nil
	}
	session, err := s.findSession(ctx, refreshToken)
	if err != nil {
		// Unknown/already revoked token — logout is idempotent, this is not an error.
		return nil
	}
	if err = s.sessions.RevokeSession(ctx, session.ID); err != nil {
		return err
	}
	return nil
}

func (s *AuthService) findSession(ctx context.Context, refreshToken string) (sqlc.FindSessionByHashRow, error) {
	return s.sessions.FindSessionByHash(ctx, hashToken(refreshToken))
}

// issueSession creates an opaque refresh token and stores its SHA-256 hash in
// the DB, chaining the new session to the rotated-away token it replaces
// (replacedBy = 0 for fresh logins, which start a new family).
func (s *AuthService) issueSession(ctx context.Context, userID int64, replacedBy int64) (string, error) {
	refresh, err := generateRefreshToken()
	if err != nil {
		return "", fmt.Errorf("failed to generate refresh token")
	}
	replaced := pgtype.Int8{}
	if replacedBy != 0 {
		replaced = pgtype.Int8{Int64: replacedBy, Valid: true}
	}
	_, err = s.sessions.CreateSession(
		ctx,
		userID,
		hashToken(refresh),
		time.Now().Add(s.jwt.RefreshExpiry()),
		replaced,
	)
	if err != nil {
		return "", fmt.Errorf("failed to create session")
	}
	return refresh, nil
}

// issuePair signs a fresh access token and returns the full session result
// (the new refresh token is created and chained to predecessorID).
func (s *AuthService) issuePair(
	ctx context.Context,
	user *userDTO.UserResponse,
	predecessorID int64,
) (*dto.SessionResult, error) {
	refresh, err := s.issueSession(ctx, user.ID, predecessorID)
	if err != nil {
		return nil, err
	}
	access, err := s.jwt.GenerateAccessToken(user.ID, user.Username)
	if err != nil {
		return nil, fmt.Errorf("failed to generate access token")
	}
	return &dto.SessionResult{
		Auth:         s.newAuthResponse(user, access),
		RefreshToken: refresh,
	}, nil
}

// startSweep launches the background expired-session sweep exactly once (the
// first auth call triggers it): dead sessions older than the sweep window are
// deleted hourly instead of only when a refresh happens.
func (s *AuthService) startSweep() {
	s.cleanupOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(sessionSweepInterval)
			defer ticker.Stop()
			for range ticker.C {
				s.sweepExpired(context.Background())
			}
		}()
	})
}

// sweepExpired — background cleanup of long-expired sessions (best-effort).
func (s *AuthService) sweepExpired(ctx context.Context) {
	_ = s.sessions.DeleteExpiredSessions(ctx, time.Now().Add(-activeSessionSweepWindow))
}

// generateRefreshToken — an opaque 256-bit token (crypto/rand, hex).
func generateRefreshToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// hashToken — SHA-256 of the token; only the hash is stored in the DB.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *AuthService) newAuthResponse(user *userDTO.UserResponse, access string) *dto.AuthResponse {
	return &dto.AuthResponse{
		AccessToken: access,
		TokenType:   "Bearer",
		ExpiresIn:   int(s.jwt.AccessExpiry().Seconds()),
		User: dto.UserInfo{
			ID:         user.ID,
			Name:       user.Name,
			LastName:   user.LastName,
			FirstName:  user.FirstName,
			MiddleName: user.MiddleName,
			Username:   user.Username,
			Preset:     user.Preset,
		},
	}
}
