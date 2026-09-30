package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// User is a hub account.
type User struct {
	ID           string
	Email        string
	Name         string
	PasswordHash string
	Role         string
	CreatedAt    time.Time
}

// CreateUser inserts a user.
func (s *Store) CreateUser(ctx context.Context, u *User) error {
	if u.ID == "" {
		u.ID = uuid.NewString()
	}
	if u.CreatedAt.IsZero() {
		u.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO users(id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.Name, u.PasswordHash, u.Role, u.CreatedAt)
	return err
}

// GetUserByEmail looks a user up.
func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, `SELECT id, email, name, password_hash, role, created_at FROM users WHERE email = ?`, email))
}

// GetUser looks a user up by id.
func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, `SELECT id, email, name, password_hash, role, created_at FROM users WHERE id = ?`, id))
}

// CountUsers returns the number of users.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
