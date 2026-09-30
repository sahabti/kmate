package handlers

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/mux"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/client-go/transport/spdy"
	utilexec "k8s.io/client-go/util/exec"
)

// streamWriter writes bytes to the stream as Data frames on a channel.
type streamWriter struct {
	st      *mux.Stream
	channel int32
}

func (w *streamWriter) Write(p []byte) (int, error) {
	// chunk to keep frames modest
	const max = 64 * 1024
	for off := 0; off < len(p); off += max {
		end := off + max
		if end > len(p) {
			end = len(p)
		}
		b := make([]byte, end-off)
		copy(b, p[off:end])
		if err := w.st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Bytes: b, Channel: w.channel}}}); err != nil {
			return off, err
		}
	}
	return len(p), nil
}

// streamReader turns inbound Data frames (channel 0) into an io.Reader, and
// forwards Resize frames to a TerminalSizeQueue.
type streamReader struct {
	st      *mux.Stream
	ctx     context.Context
	buf     []byte
	eof     bool
	resizes chan remotecommand.TerminalSize
	closed  chan struct{}
	once    sync.Once
}

func newStreamReader(ctx context.Context, st *mux.Stream) *streamReader {
	return &streamReader{st: st, ctx: ctx, resizes: make(chan remotecommand.TerminalSize, 8), closed: make(chan struct{})}
}

func (r *streamReader) Read(p []byte) (int, error) {
	for len(r.buf) == 0 {
		if r.eof {
			return 0, io.EOF
		}
		f, err := r.st.Recv(r.ctx)
		if err != nil {
			r.markClosed()
			return 0, io.EOF
		}
		switch pl := f.Payload.(type) {
		case *kmatev1.Frame_Data:
			r.buf = append(r.buf, pl.Data.Bytes...)
			if pl.Data.Eof {
				r.eof = true
			}
		case *kmatev1.Frame_Resize:
			select {
			case r.resizes <- remotecommand.TerminalSize{Width: uint16(pl.Resize.Cols), Height: uint16(pl.Resize.Rows)}:
			default:
			}
		case *kmatev1.Frame_Close:
			r.markClosed()
			return 0, io.EOF
		}
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}

func (r *streamReader) markClosed() { r.once.Do(func() { close(r.closed) }) }

func (r *streamReader) Next() *remotecommand.TerminalSize {
	select {
	case s := <-r.resizes:
		return &s
	case <-r.closed:
		return nil
	case <-r.ctx.Done():
		return nil
	}
}

func (h *Handler) logs(ctx context.Context, st *mux.Stream, req *kmatev1.Request, l *kmatev1.LogsRequest) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	_, cs := h.Clients.ForIdentity(req.Identity)

	containers := []string{l.Container}
	if l.AllContainers || l.Container == "" {
		pod, err := cs.CoreV1().Pods(l.Namespace).Get(ctx, l.Pod, metav1.GetOptions{})
		if err != nil {
			_ = st.Close(toError(err))
			return err
		}
		containers = nil
		if l.AllContainers {
			for _, c := range pod.Spec.InitContainers {
				containers = append(containers, c.Name)
			}
		}
		for _, c := range pod.Spec.Containers {
			containers = append(containers, c.Name)
			if !l.AllContainers {
				break
			}
		}
	}
	// peer close watcher
	go func() {
		for {
			f, err := st.Recv(ctx)
			if err != nil || f.GetClose() != nil {
				cancel()
				return
			}
		}
	}()

	w := &streamWriter{st: st}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for _, c := range containers {
		opts := &corev1.PodLogOptions{Container: c, Follow: l.Follow, Timestamps: l.Timestamps, Previous: l.Previous}
		if l.TailLines > 0 {
			opts.TailLines = &l.TailLines
		}
		if l.SinceSeconds > 0 {
			opts.SinceSeconds = &l.SinceSeconds
		}
		wg.Add(1)
		go func(c string, opts *corev1.PodLogOptions) {
			defer wg.Done()
			rc, err := cs.CoreV1().Pods(l.Namespace).GetLogs(l.Pod, opts).Stream(ctx)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				return
			}
			defer rc.Close()
			if l.AllContainers && len(containers) > 1 {
				prefix := []byte("[" + c + "] ")
				sc := bufio.NewReaderSize(rc, 64*1024)
				for {
					line, err := sc.ReadBytes('\n')
					if len(line) > 0 {
						mu.Lock()
						_, werr := w.Write(append(append([]byte{}, prefix...), line...))
						mu.Unlock()
						if werr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}
			buf := make([]byte, 32*1024)
			for {
				n, err := rc.Read(buf)
				if n > 0 {
					mu.Lock()
					_, werr := w.Write(buf[:n])
					mu.Unlock()
					if werr != nil {
						return
					}
				}
				if err != nil {
					return
				}
			}
		}(c, opts)
	}
	wg.Wait()
	if firstErr != nil {
		_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Bytes: []byte("error: " + firstErr.Error() + "\n"), Eof: true}}})
		_ = st.Close(toError(firstErr))
		return firstErr
	}
	_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Eof: true}}})
	_ = st.Close(nil)
	return nil
}

func (h *Handler) exec(ctx context.Context, st *mux.Stream, req *kmatev1.Request, e *kmatev1.ExecRequest) error {
	if !h.CanExec {
		err := apierrors.NewForbidden(schema.GroupResource{Resource: "pods/exec"}, e.Pod, errors.New("exec disabled on agent (rbac.exec=false)"))
		_ = st.Close(toError(err))
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg := h.Clients.ConfigForIdentity(req.Identity)
	_, cs := h.Clients.ForIdentity(req.Identity)

	cmd := e.Command
	if len(cmd) == 0 {
		cmd = []string{"/bin/sh"}
	}
	r := cs.CoreV1().RESTClient().Post().Resource("pods").Namespace(e.Namespace).Name(e.Pod).SubResource("exec")
	r.VersionedParams(&corev1.PodExecOptions{
		Container: e.Container, Command: cmd,
		Stdin: e.Stdin, Stdout: true, Stderr: !e.Tty, TTY: e.Tty,
	}, scheme.ParameterCodec)

	executor, err := newExecutor(cfg, r.URL())
	if err != nil {
		_ = st.Close(toError(err))
		return err
	}
	reader := newStreamReader(ctx, st)
	if e.Cols > 0 && e.Rows > 0 {
		reader.resizes <- remotecommand.TerminalSize{Width: uint16(e.Cols), Height: uint16(e.Rows)}
	}
	opts := remotecommand.StreamOptions{
		Stdout: &streamWriter{st: st, channel: 1},
		Stderr: &streamWriter{st: st, channel: 2},
		Tty:    e.Tty,
	}
	if e.Stdin {
		opts.Stdin = reader
	} else {
		// still need to consume frames to detect peer close
		go func() {
			buf := make([]byte, 1024)
			for {
				if _, err := reader.Read(buf); err != nil {
					cancel()
					return
				}
			}
		}()
	}
	if e.Tty {
		opts.TerminalSizeQueue = reader
	}
	err = executor.StreamWithContext(ctx, opts)
	if err != nil && !errors.Is(err, context.Canceled) {
		var ce utilexec.ExitError
		if errors.As(err, &ce) {
			_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Channel: 2, Bytes: []byte(fmt.Sprintf("\r\n[process exited with code %d]\r\n", ce.ExitStatus())), Eof: true}}})
			_ = st.Close(nil)
			return nil
		}
		_ = st.Close(toError(err))
		return err
	}
	_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Channel: 1, Eof: true}}})
	_ = st.Close(nil)
	return nil
}

func newExecutor(cfg *rest.Config, u *url.URL) (remotecommand.Executor, error) {
	spdyExec, err := remotecommand.NewSPDYExecutor(cfg, "POST", u)
	if err != nil {
		return nil, err
	}
	wsExec, err := remotecommand.NewWebSocketExecutor(cfg, "GET", u.String())
	if err != nil {
		return spdyExec, nil
	}
	return remotecommand.NewFallbackExecutor(wsExec, spdyExec, httpstream.IsUpgradeFailure)
}

// portForward opens a single port-forward data stream to a pod and pumps bytes.
// Each tunnel stream corresponds to exactly one TCP connection.
func (h *Handler) portForward(ctx context.Context, st *mux.Stream, req *kmatev1.Request, pf *kmatev1.PortForwardRequest) error {
	if !h.CanExec {
		err := apierrors.NewForbidden(schema.GroupResource{Resource: "pods/portforward"}, pf.Pod, errors.New("port-forward disabled on agent (rbac.exec=false)"))
		_ = st.Close(toError(err))
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cfg := h.Clients.ConfigForIdentity(req.Identity)
	_, cs := h.Clients.ForIdentity(req.Identity)

	r := cs.CoreV1().RESTClient().Post().Resource("pods").Namespace(pf.Namespace).Name(pf.Pod).SubResource("portforward")
	transport, upgrader, err := spdy.RoundTripperFor(cfg)
	if err != nil {
		_ = st.Close(toError(err))
		return err
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, "POST", r.URL())
	if wsDialer, werr := portforward.NewSPDYOverWebsocketDialer(r.URL(), cfg); werr == nil {
		dialer = portforward.NewFallbackDialer(wsDialer, dialer, func(err error) bool { return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err) })
	}
	conn, _, err := dialer.Dial(portforward.PortForwardProtocolV1Name)
	if err != nil {
		_ = st.Close(toError(err))
		return err
	}
	defer conn.Close()

	headers := http.Header{}
	headers.Set(corev1.StreamType, corev1.StreamTypeError)
	headers.Set(corev1.PortHeader, fmt.Sprintf("%d", pf.Port))
	headers.Set(corev1.PortForwardRequestIDHeader, "0")
	errStream, err := conn.CreateStream(headers)
	if err != nil {
		_ = st.Close(toError(err))
		return err
	}
	_ = errStream.Close()
	headers.Set(corev1.StreamType, corev1.StreamTypeData)
	dataStream, err := conn.CreateStream(headers)
	if err != nil {
		_ = st.Close(toError(err))
		return err
	}
	defer dataStream.Close()

	errCh := make(chan error, 3)
	go func() {
		b, _ := io.ReadAll(errStream)
		if len(b) > 0 {
			errCh <- fmt.Errorf("port-forward: %s", strings.TrimSpace(string(b)))
		}
	}()
	go func() {
		_, err := io.Copy(&streamWriter{st: st}, dataStream)
		errCh <- err
	}()
	go func() {
		reader := newStreamReader(ctx, st)
		_, err := io.Copy(dataStream, reader)
		_ = dataStream.Close()
		errCh <- err
	}()
	select {
	case err = <-errCh:
	case <-ctx.Done():
		err = ctx.Err()
	}
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		_ = st.Close(toError(err))
		return err
	}
	_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Eof: true}}})
	_ = st.Close(nil)
	return nil
}
