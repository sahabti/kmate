package store

import (
	"context"
	"errors"

	"github.com/kmate-dev/kmate/internal/hub/oidc"
)

// OIDCDirectory adapts the store to the login flow's Directory interface, so
// the oidc package needs no knowledge of the database.
type OIDCDirectory struct{ S *Store }

// GetUserByEmail returns the account, or (nil, nil) when there is none.
func (d OIDCDirectory) GetUserByEmail(ctx context.Context, email string) (*oidc.DirUser, error) {
	u, err := d.S.GetUserByEmail(ctx, email)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return toDirUser(u), nil
}

// CreateUser provisions an account and copies the generated id back.
func (d OIDCDirectory) CreateUser(ctx context.Context, du *oidc.DirUser) error {
	u := &User{
		Email: du.Email, Name: du.Name, Role: du.Role,
		K8sUser: du.K8sUser, K8sGroups: du.K8sGroups, Active: du.Active, OIDC: du.OIDC,
	}
	if err := d.S.CreateUser(ctx, u); err != nil {
		return err
	}
	du.ID = u.ID
	return nil
}

// UpdateUser writes the mutable fields back.
func (d OIDCDirectory) UpdateUser(ctx context.Context, du *oidc.DirUser) error {
	u, err := d.S.GetUser(ctx, du.ID)
	if err != nil {
		return err
	}
	u.Name, u.Role, u.K8sUser, u.K8sGroups, u.Active, u.OIDC = du.Name, du.Role, du.K8sUser, du.K8sGroups, du.Active, du.OIDC
	return d.S.UpdateUser(ctx, u)
}

// Audit records a login or provisioning event.
func (d OIDCDirectory) Audit(ctx context.Context, user, action, target, result string) {
	_ = d.S.Audit(ctx, AuditEvent{User: user, Action: action, Target: target, Result: result})
}

func toDirUser(u *User) *oidc.DirUser {
	return &oidc.DirUser{
		ID: u.ID, Email: u.Email, Name: u.Name, Role: u.Role,
		K8sUser: u.K8sUser, K8sGroups: u.K8sGroups, Active: u.Active, OIDC: u.OIDC,
	}
}
