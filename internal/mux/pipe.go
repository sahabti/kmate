package mux

import (
	"errors"
	"sync"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

// Pipe returns two in-memory Conns wired to each other. Useful for tests.
func Pipe() (Conn, Conn) {
	ab := make(chan *kmatev1.Frame, 1024)
	ba := make(chan *kmatev1.Frame, 1024)
	closed := &pipeState{done: make(chan struct{})}
	return &pipeConn{out: ab, in: ba, st: closed}, &pipeConn{out: ba, in: ab, st: closed}
}

type pipeState struct {
	once sync.Once
	done chan struct{}
}

type pipeConn struct {
	out chan<- *kmatev1.Frame
	in  <-chan *kmatev1.Frame
	st  *pipeState
}

func (p *pipeConn) Send(f *kmatev1.Frame) error {
	select {
	case <-p.st.done:
		return errors.New("pipe closed")
	case p.out <- f:
		return nil
	}
}

func (p *pipeConn) Recv() (*kmatev1.Frame, error) {
	select {
	case <-p.st.done:
		return nil, errors.New("pipe closed")
	case f := <-p.in:
		return f, nil
	}
}

// ClosePipe ends both ends.
func ClosePipe(c Conn) {
	if p, ok := c.(*pipeConn); ok {
		p.st.once.Do(func() { close(p.st.done) })
	}
}
