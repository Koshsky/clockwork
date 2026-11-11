package hasher

import "golang.org/x/crypto/bcrypt"

// bcryptCost is the work factor for new password hashes (raised from the
// bcrypt default of 10 per the CODE_REVIEW plan; verification of hashes
// created with a lower cost keeps working because bcrypt reads the cost from
// the hash itself).
const bcryptCost = 12

func Hash(raw string) (string, error) {
	hashed, err := bcrypt.GenerateFromPassword([]byte(raw), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hashed), nil
}

func Compare(hashed, raw string) error {
	return bcrypt.CompareHashAndPassword([]byte(hashed), []byte(raw))
}
