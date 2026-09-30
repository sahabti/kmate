package mux

import (
	"context"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

func TestOpenAcceptRoundTrip(t *testing.T) {
	a, b := Pipe()
	hub := New(a, Initiator)
	agent := New(b, Responder)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go hub.Run(ctx)
	go agent.Run(ctx)

	st, err := hub.Open()
	if err != nil {
		t.Fatal(err)
	}
	if st.ID%2 != 0 {
		t.Fatalf("hub stream id should be even, got %d", st.ID)
	}
	if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Request{Request: &kmatev1.Request{RequestId: "r1"}}}); err != nil {
		t.Fatal(err)
	}

	got, err := agent.Accept(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f, err := got.Recv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if f.GetRequest().GetRequestId() != "r1" {
		t.Fatalf("unexpected first frame %v", f)
	}
	if err := got.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Response{Response: &kmatev1.Response{}}}); err != nil {
		t.Fatal(err)
	}
	if err := got.Close(nil); err != nil {
		t.Fatal(err)
	}

	resp, err := st.Recv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetResponse() == nil {
		t.Fatalf("expected response, got %v", resp)
	}
	cl, err := st.Recv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cl.GetClose() == nil {
		t.Fatalf("expected close, got %v", cl)
	}
	if _, err := st.Recv(ctx); err == nil {
		t.Fatal("expected error after close")
	}
}

func TestControlFrames(t *testing.T) {
	a, b := Pipe()
	hub := New(a, Initiator)
	agent := New(b, Responder)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go hub.Run(ctx)
	go agent.Run(ctx)

	if err := agent.SendControl(&kmatev1.Frame{Payload: &kmatev1.Frame_Hello{Hello: &kmatev1.Hello{AgentId: "x"}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case f := <-hub.Control():
		if f.GetHello().GetAgentId() != "x" {
			t.Fatalf("bad hello %v", f)
		}
	case <-ctx.Done():
		t.Fatal("timeout")
	}
}

func TestSessionShutdownClosesStreams(t *testing.T) {
	a, b := Pipe()
	hub := New(a, Initiator)
	agent := New(b, Responder)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go hub.Run(ctx)
	go agent.Run(ctx)
	st, _ := hub.Open()
	ClosePipe(a)
	select {
	case <-st.Context().Done():
	case <-time.After(2 * time.Second):
		t.Fatal("stream not closed on session shutdown")
	}
}
