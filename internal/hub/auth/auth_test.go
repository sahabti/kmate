package auth

import "testing"

func TestIssueVerify(t *testing.T) {
	a := New([]byte("secret"))
	tok, err := a.Issue(&Principal{ID: "u1", Email: "a@b", Role: RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.Verify(tok)
	if err != nil || p.ID != "u1" || p.Email != "a@b" || p.Role != RoleAdmin {
		t.Fatalf("verify: %v %+v", err, p)
	}
	if _, err := New([]byte("other")).Verify(tok); err == nil {
		t.Fatal("expected failure with wrong secret")
	}
	h, _ := HashPassword("pw")
	if !CheckPassword(h, "pw") || CheckPassword(h, "nope") {
		t.Fatal("password check")
	}
}
