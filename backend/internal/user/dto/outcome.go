package dto

import (
	"time"

	"github.com/Koshsky/erp-backend/pkg/date"
)

// UserResponse — user data (incl. worker profile fields).
type UserResponse struct {
	ID int64 `json:"id" example:"1"`
	// Full name "Last First Middle" (pre-composed, for display).
	Name            string     `json:"name"             example:"Иванов Иван Иванович"`
	LastName        string     `json:"last_name"        example:"Иванов"`
	FirstName       string     `json:"first_name"       example:"Иван"`
	MiddleName      *string    `json:"middle_name"      example:"Иванович"`
	Username        string     `json:"username"         example:"worker_1"`
	Preset          *string    `json:"preset"           example:"worker"`
	ManagerID       *int64     `json:"manager_id"       example:"5"`
	Position        string     `json:"position"         example:"Инженер 2 категории"`
	HireDate        *date.Date `json:"hire_date"        example:"2024-01-15"           format:"date"`
	TerminationDate *date.Date `json:"termination_date" example:"2026-12-31"           format:"date"`
	// PasswordHash never serializes in the regular response (only AdminUserResponse).
	PasswordHash string `json:"-"`
	// CreatedAt never serializes in the regular response (only AdminUserResponse).
	CreatedAt time.Time `json:"-"`
}

// CreateUserResult — the created user; password is returned once,
// if credentials were generated automatically.
type CreateUserResult struct {
	User     UserResponse `json:"user"`
	Password string       `json:"password,omitempty"`
}

// ResetPasswordResult — the freshly generated password after an admin
// password reset; shown to the administrator exactly once.
type ResetPasswordResult struct {
	Password string `json:"password" example:"xK9#mP2vQ7"`
}

// AdminUserResponse — user for the admin page (including the password hash).
type AdminUserResponse struct {
	ID              int64      `json:"id"               example:"1"`
	Name            string     `json:"name"             example:"Иванов Иван Иванович"`
	LastName        string     `json:"last_name"        example:"Иванов"`
	FirstName       string     `json:"first_name"       example:"Иван"`
	MiddleName      *string    `json:"middle_name"      example:"Иванович"`
	Username        string     `json:"username"         example:"worker_1"`
	Preset          *string    `json:"preset"           example:"worker"`
	ManagerID       *int64     `json:"manager_id"       example:"5"`
	Position        string     `json:"position"         example:"Инженер 2 категории"`
	HireDate        *date.Date `json:"hire_date"        example:"2024-01-15"           format:"date"`
	TerminationDate *date.Date `json:"termination_date" example:"2026-12-31"           format:"date"`
	// Account registration time (email/username created at).
	CreatedAt    time.Time `json:"created_at"              example:"2026-08-28T07:00:00Z" format:"date-time"`
	PasswordHash string    `json:"password_hash,omitempty" example:"$2a$10$..."`
}

type UserStateResponse struct {
	ID          int64     `json:"id"           example:"1"`
	StateID     int64     `json:"state_id"     example:"4"`
	StateCode   string    `json:"state_code"   example:"ОТП"`
	StateName   string    `json:"state_name"   example:"Отпуск"`
	IsAvailable bool      `json:"is_available" example:"false"`
	StartDate   date.Date `json:"start_date"   example:"2026-07-20" format:"date"`
	EndDate     date.Date `json:"end_date"     example:"2026-08-02" format:"date"`
	// UserID is set only in batch responses (GET /user/days), where one worker's
	// ranges are nested among several — hence omitempty.
	UserID int64 `json:"user_id,omitempty" example:"7"`
}

// UserStatesResponse — the calendar states of one worker inside a batch
// response; days has the same shape as the single-worker listing and is an
// empty array (never null) when the worker has no states in the range.
type UserStatesResponse struct {
	UserID int64               `json:"user_id" example:"7"`
	Days   []UserStateResponse `json:"days"`
}

type ChangePasswordResponse struct {
	Message string `json:"message" example:"password changed"`
}
