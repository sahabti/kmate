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
	// K8sUser is the Kubernetes username used when the agent impersonates this
	// person. Empty means "use Email". K8sGroups default to ["kmate:<role>"].
	K8sUser   string
	K8sGroups []string
	Active    bool
	// OIDC marks an account provisioned by an identity provider. Such accounts
	// have no usable password and are refused by the local login path.
	OIDC      bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// EffectiveK8sUser is the username the agent impersonates.
func (u *User) EffectiveK8sUser() string {
	if u.K8sUser != "" {
		return u.K8sUser
	}
	return u.Email
}

// RoleGroup is the Kubernetes group that always accompanies a user's KMate
// role, so cluster RBAC can be bound to the role rather than to whatever an
// identity provider happens to call its groups.
func (u *User) RoleGroup() string { return "kmate:" + u.Role }

// EffectiveK8sGroups are the groups the agent impersonates.
//
// The role group is always present. Groups from an identity provider are
// carried through as well, so an existing Kubernetes binding against an IdP
// group keeps working, but a cluster can bind kmate:admin and have it apply to
// every admin regardless of how the provider names its groups. Without this the
// role group reached local accounts only, because an OIDC login always writes
// the provider's groups into k8s_groups and so never fell back to it.
func (u *User) EffectiveK8sGroups() []string {
	role := u.RoleGroup()
	if len(u.K8sGroups) == 0 {
		return []string{role}
	}
	out := make([]string, 0, len(u.K8sGroups)+1)
	for _, g := range u.K8sGroups {
		if g == role {
			// Already supplied explicitly; do not impersonate it twice.
			return append(out, u.K8sGroups...)
		}
		out = append(out, g)
	}

	return append(out, role)
}

const userCols = `id, email, name, password_hash, role, k8s_user, k8s_groups, active, oidc, created_at, updated_at`

// CreateUser inserts a user.
func (s *Store) CreateUser(ctx context.Context, u *User) error {
	if u.ID == "" {
		u.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	if u.CreatedAt.IsZero() {
		u.CreatedAt = now
	}
	if u.UpdatedAt.IsZero() {
		u.UpdatedAt = now
	}
	if !u.Active {
		u.Active = true // new users are active unless explicitly deactivated later
	}
	groups, err := encodeList(u.K8sGroups)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users(`+userCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.Name, u.PasswordHash, u.Role, u.K8sUser, groups, u.Active, u.OIDC, u.CreatedAt, u.UpdatedAt)
	return err
}

// GetUserByEmail looks a user up.
func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE email = ?`, email))
}

// GetUser looks a user up by id.
func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

// ListUsers returns every account, newest last.
func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUserRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UpdateUser writes the mutable fields.
func (s *Store) UpdateUser(ctx context.Context, u *User) error {
	groups, err := encodeList(u.K8sGroups)
	if err != nil {
		return err
	}
	u.UpdatedAt = time.Now().UTC()
	_, err = s.db.ExecContext(ctx,
		`UPDATE users SET name = ?, role = ?, k8s_user = ?, k8s_groups = ?, active = ?, oidc = ?, updated_at = ? WHERE id = ?`,
		u.Name, u.Role, u.K8sUser, groups, u.Active, u.OIDC, u.UpdatedAt, u.ID)
	return err
}

// SetPasswordHash updates only the password.
func (s *Store) SetPasswordHash(ctx context.Context, id, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, hash, time.Now().UTC(), id)
	return err
}

// DeleteUser removes an account and its grants (ON DELETE CASCADE).
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	return err
}

// CountUsers returns the number of users.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CountActiveAdmins counts active administrators, used to refuse removing the last one.
func (s *Store) CountActiveAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1`).Scan(&n)
	return n, err
}

type rowScanner interface{ Scan(...any) error }

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	u, err := scanUserRows(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

func scanUserRows(r rowScanner) (*User, error) {
	var u User
	var groups string
	var updated sql.NullTime
	if err := r.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &u.K8sUser, &groups, &u.Active, &u.OIDC, &u.CreatedAt, &updated); err != nil {
		return nil, err
	}
	u.K8sGroups = decodeList(groups)
	if updated.Valid {
		u.UpdatedAt = updated.Time
	}
	return &u, nil
}
