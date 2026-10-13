package api

import (
	"connectrpc.com/connect"
	"context"
	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"testing"
)

func TestPasswordEndpointRespectsDisabledLogin(t *testing.T) {
	f := newFixture(t)
	f.hub.cfg.DisableLocalLogin = true
	_, err := f.hub.Login(context.Background(), connect.NewRequest(&kmatev1.LoginRequest{Email: "admin@x", Password: "anything"}))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("password login not disabled: %v", err)
	}
}
