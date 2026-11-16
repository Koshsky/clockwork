package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// FindAccountByID keeps password hashes out of session renewal.
func (s *UserService) FindAccountByID(ctx context.Context, id int64) (*domain.Account, error) {
	ctx, end := s.tracer.Start(ctx, "user.FindUserByID")
	defer end(nil)
	user, err := s.findUserRow(ctx, id)
	if err != nil {
		return nil, err
	}
	return accountFromRow(user), nil
}

// ListUserIdentities supplies audit search and enrichment without account secrets.
func (s *UserService) ListUserIdentities(ctx context.Context) ([]domain.Identity, error) {
	ctx, end := s.tracer.Start(ctx, "user.ListAllUsers")
	defer end(nil)
	users, err := s.repository.ListAllUsers(ctx)
	if err != nil {
		return nil, err
	}
	identities := make([]domain.Identity, len(users))
	for i, user := range users {
		identities[i] = identityFromRow(user)
	}
	return identities, nil
}

func (s *UserService) findUserRow(ctx context.Context, id int64) (*sqlc.User, error) {
	ctx, end := s.tracer.Start(ctx, "user.FindUser")
	defer end(nil)
	user, err := s.repository.FindUser(ctx, id)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errors.NotFound("user not found")
	}
	return user, nil
}

func accountFromRow(user *sqlc.User) *domain.Account {
	return &domain.Account{Identity: identityFromRow(*user), Preset: nullable.StringPtr(user.Preset)}
}

func identityFromRow(user sqlc.User) domain.Identity {
	return domain.Identity{
		ID: user.ID, Name: fullName(user), LastName: user.LastName, FirstName: user.FirstName,
		MiddleName: nullable.StringPtr(user.MiddleName), Username: user.Username,
	}
}
