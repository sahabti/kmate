// Package mux multiplexes many logical streams over a single bidirectional
// gRPC Frame stream (kmate.v1.AgentService/Tunnel). Both the agent and the hub
// use it: the hub is the Initiator side (even stream ids), the agent is the
// Responder side (odd stream ids). Stream id 0 is reserved for control frames
// (Hello, Heartbeat).
package mux

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

// Conn is satisfied by both grpc client and server Tunnel streams.
type Conn interface {
	Send(*kmatev1.Frame) error
	Recv() (*kmatev1.Frame, error)
}

// Role decides stream id parity.
type Role int

const (
	// Initiator opens even stream ids (the hub).
	Initiator Role = iota
	// Responder opens odd stream ids (the agent).
	Responder
)

var (
	ErrSessionClosed = errors.New("mux: session closed")
	ErrStreamClosed  = errors.New("mux: stream closed")
	ErrSlowConsumer  = errors.New("mux: slow consumer")
)

const (
	streamBuffer    = 256
	slowConsumerMax = 10 * time.Second
	controlBuffer   = 32
)

// Session owns one tunnel connection.
type Session struct {
	conn Conn
	role Role

	sendMu sync.Mutex

	mu      sync.Mutex
	streams map[uint32]*Stream
	nextID  uint32

	accept  chan *Stream
	control chan *kmatev1.Frame

	closeOnce sync.Once
	closed    chan struct{}
	err       atomic.Value // error
}

// New creates a session; call Run to start the read loop.
func New(conn Conn, role Role) *Session {
	s := &Session{
		conn:    conn,
		role:    role,
		streams: make(map[uint32]*Stream),
		accept:  make(chan *Stream, 64),
		control: make(chan *kmatev1.Frame, controlBuffer),
		closed:  make(chan struct{}),
	}
	if role == Initiator {
		s.nextID = 2
	} else {
		s.nextID = 1
	}
	return s
}

// Run reads frames until the connection fails or ctx is done. It always
// returns a non-nil error describing why the session ended.
func (s *Session) Run(ctx context.Context) error {
	go func() {
		<-ctx.Done()
		s.shutdown(ctx.Err())
	}()
	for {
		f, err := s.conn.Recv()
		if err != nil {
			s.shutdown(err)
			return err
		}
		s.dispatch(f)
	}
}

func (s *Session) dispatch(f *kmatev1.Frame) {
	if f.StreamId == 0 {
		select {
		case s.control <- f:
		default:
			// drop control frames if nobody is reading; heartbeats are periodic anyway
		}
		return
	}
	s.mu.Lock()
	st, ok := s.streams[f.StreamId]
	if !ok {
		if _, isClose := f.Payload.(*kmatev1.Frame_Close); isClose {
			s.mu.Unlock()
			return
		}
		if s.isPeerID(f.StreamId) {
			st = s.newStream(f.StreamId)
			s.streams[f.StreamId] = st
			s.mu.Unlock()
			select {
			case s.accept <- st:
			default:
				// accept backlog full: reject
				st.closeLocal(errors.New("mux: accept backlog full"))
				_ = s.sendClose(f.StreamId, &kmatev1.Error{Code: 503, Message: "accept backlog full"})
				return
			}
		} else {
			s.mu.Unlock()
			return // frame for a stream we already closed
		}
	} else {
		s.mu.Unlock()
	}

	if _, isClose := f.Payload.(*kmatev1.Frame_Close); isClose {
		st.deliver(f)
		s.removeStream(st.ID)
		st.closeLocal(nil)
		return
	}
	if !st.deliverWithTimeout(f, slowConsumerMax) {
		s.removeStream(st.ID)
		st.closeLocal(ErrSlowConsumer)
		_ = s.sendClose(st.ID, &kmatev1.Error{Code: 429, Message: "slow consumer"})
	}
}

func (s *Session) isPeerID(id uint32) bool {
	if s.role == Initiator {
		return id%2 == 1
	}
	return id%2 == 0
}

// Open allocates a new stream. The caller sends the first frame.
func (s *Session) Open() (*Stream, error) {
	select {
	case <-s.closed:
		return nil, ErrSessionClosed
	default:
	}
	s.mu.Lock()
	id := s.nextID
	s.nextID += 2
	st := s.newStream(id)
	s.streams[id] = st
	s.mu.Unlock()
	return st, nil
}

// Accept returns the next stream opened by the peer.
func (s *Session) Accept(ctx context.Context) (*Stream, error) {
	select {
	case st := <-s.accept:
		return st, nil
	case <-s.closed:
		return nil, s.Err()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Control returns control frames (stream id 0).
func (s *Session) Control() <-chan *kmatev1.Frame { return s.control }

// SendControl sends a frame on stream 0.
func (s *Session) SendControl(f *kmatev1.Frame) error {
	f.StreamId = 0
	return s.send(f)
}

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.closed }

// Err returns the reason the session ended (nil while running).
func (s *Session) Err() error {
	if v := s.err.Load(); v != nil {
		return v.(error)
	}
	return nil
}

// Close ends the session.
func (s *Session) Close() { s.shutdown(ErrSessionClosed) }

func (s *Session) send(f *kmatev1.Frame) error {
	select {
	case <-s.closed:
		return ErrSessionClosed
	default:
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	if err := s.conn.Send(f); err != nil {
		s.shutdown(err)
		return err
	}
	return nil
}

func (s *Session) sendClose(id uint32, e *kmatev1.Error) error {
	return s.send(&kmatev1.Frame{StreamId: id, Payload: &kmatev1.Frame_Close{Close: &kmatev1.Close{Error: e}}})
}

func (s *Session) removeStream(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	s.mu.Unlock()
}

func (s *Session) shutdown(err error) {
	s.closeOnce.Do(func() {
		if err == nil {
			err = ErrSessionClosed
		}
		s.err.Store(err)
		close(s.closed)
		s.mu.Lock()
		streams := make([]*Stream, 0, len(s.streams))
		for _, st := range s.streams {
			streams = append(streams, st)
		}
		s.streams = map[uint32]*Stream{}
		s.mu.Unlock()
		for _, st := range streams {
			st.closeLocal(err)
		}
	})
}

func (s *Session) newStream(id uint32) *Stream {
	ctx, cancel := context.WithCancel(context.Background())
	return &Stream{
		ID:     id,
		sess:   s,
		in:     make(chan *kmatev1.Frame, streamBuffer),
		ctx:    ctx,
		cancel: cancel,
	}
}

// Stream is one logical stream on a session.
type Stream struct {
	ID   uint32
	sess *Session
	in   chan *kmatev1.Frame

	ctx    context.Context
	cancel context.CancelFunc

	closeOnce sync.Once
	closeErr  atomic.Value
}

// Context is cancelled when the stream is closed by either side.
func (st *Stream) Context() context.Context { return st.ctx }

// Send sends a frame on this stream. The payload must be set; stream_id is filled in.
func (st *Stream) Send(f *kmatev1.Frame) error {
	select {
	case <-st.ctx.Done():
		return st.Err()
	default:
	}
	f.StreamId = st.ID
	return st.sess.send(f)
}

// Recv returns the next inbound frame. A Close frame from the peer is
// delivered once, after which Recv returns ErrStreamClosed (or the peer's error).
func (st *Stream) Recv(ctx context.Context) (*kmatev1.Frame, error) {
	select {
	case f := <-st.in:
		return f, nil
	default:
	}
	select {
	case f := <-st.in:
		return f, nil
	case <-st.ctx.Done():
		// drain anything that arrived just before close
		select {
		case f := <-st.in:
			return f, nil
		default:
		}
		return nil, st.Err()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Close sends a Close frame (with optional error) to the peer and releases the stream.
func (st *Stream) Close(e *kmatev1.Error) error {
	var err error
	st.closeOnce.Do(func() {
		st.sess.removeStream(st.ID)
		err = st.sess.sendClose(st.ID, e)
		if e != nil {
			st.closeErr.Store(fmt.Errorf("mux: stream closed: %d %s", e.Code, e.Message))
		} else {
			st.closeErr.Store(ErrStreamClosed)
		}
		st.cancel()
	})
	return err
}

// Err returns why the stream closed.
func (st *Stream) Err() error {
	if v := st.closeErr.Load(); v != nil {
		return v.(error)
	}
	select {
	case <-st.ctx.Done():
		return ErrStreamClosed
	default:
		return nil
	}
}

func (st *Stream) closeLocal(err error) {
	st.closeOnce.Do(func() {
		if err == nil {
			err = ErrStreamClosed
		}
		st.closeErr.Store(err)
		st.cancel()
	})
}

func (st *Stream) deliver(f *kmatev1.Frame) {
	select {
	case st.in <- f:
	default:
	}
}

func (st *Stream) deliverWithTimeout(f *kmatev1.Frame, d time.Duration) bool {
	select {
	case st.in <- f:
		return true
	case <-st.ctx.Done():
		return true // stream already closed locally; drop silently
	default:
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case st.in <- f:
		return true
	case <-st.ctx.Done():
		return true
	case <-t.C:
		return false
	}
}

// CloseError converts a Close frame's error into a Go error (nil if no error).
func CloseError(f *kmatev1.Frame) error {
	c, ok := f.Payload.(*kmatev1.Frame_Close)
	if !ok || c.Close == nil || c.Close.Error == nil {
		return nil
	}
	return &RemoteError{Code: c.Close.Error.Code, Reason: c.Close.Error.Reason, Message: c.Close.Error.Message}
}

// RemoteError is an error carried over the tunnel.
type RemoteError struct {
	Code    int32
	Reason  string
	Message string
}

func (e *RemoteError) Error() string {
	return fmt.Sprintf("%d %s: %s", e.Code, e.Reason, e.Message)
}
