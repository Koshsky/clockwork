package domain

// Identity contains display and search fields without credentials or permissions.
type Identity struct {
	ID         int64
	Name       string
	LastName   string
	FirstName  string
	MiddleName *string
	Username   string
}

// Account adds the assigned preset needed when issuing an authenticated session.
type Account struct {
	Identity

	Preset *string
}

// Credentials is restricted to password verification; it must never expose the hash.
type Credentials struct {
	Account

	PasswordHash string `json:"-"`
}
