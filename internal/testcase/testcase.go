// Package testcase는 Go test가 case마다 쓰는 진행 보고 형식과 case별 기한이다.
//
// 모든 case는 실행하는 동안 다음 줄을 stdout에 출력한다.
//
//	RUN <case> deadline=<기한>
//	STEP <case> elapsed=<경과>: <단계>
//	PASS <case> elapsed=<경과>
//	FAIL <case> elapsed=<경과>: <이유>
//	SKIP <case> elapsed=<경과>
//
// 여러 case를 묶는 test는 자기 기한 없이 "RUN <group> group"으로 시작하고, 묶인 case가
// 저마다 기한을 가진다. runner의 장기 작업(build, 설치, 도구 실행)은 RunLong으로 기한 없이
// "RUN <작업> no-deadline"으로 시작한다. 기한은 wall-clock 시간이다. 멈춘 case를 끝내는 timer이고 case
// 자신의 계산 시간을 재는 제한이 아니기 때문이다(AGENTS.md testing rule).
package testcase

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"runtime/pprof"
	"strings"
	"sync"
	"testing"
	"time"
)

// 기한의 등급이다. case는 자기가 하는 일에 맞는 등급을 쓰고, 등급보다 오래 걸리는 일은
// 그 기준을 주석에 밝힌 자기 기한을 쓴다.
const (
	// Compute는 memory 안의 계산과 repository file 읽기만 하는 case의 기한이다. 기준:
	// 이런 case 가운데 가장 큰 것(dbspec stress 문서의 parse와 emit, fuzz seed corpus)이
	// 몇 초 안에 끝나므로, 1분을 넘긴 case는 멈춘 것이다.
	Compute = time.Minute
	// Database는 TEST_ENV의 database에 연결해 정해진 수의 statement를 실행하는 case의
	// 기한이다. 기준: 이런 case는 database를 만들고 지우는 일을 포함해 수백 개 이하의
	// statement를 실행하고, 공유 server에서 lock을 기다리는 시간까지 2분이면 넉넉하다.
	Database = 2 * time.Minute
	// Process는 `go build`, `go run`, php, node, Rust binary 같은 하위 process를 실행하는
	// case의 기한이다. 기준: `go run`과 `go build`는 build cache가 비었을 때 package와
	// 의존성을 다시 compile하는 데 몇 분이 걸린다.
	Process = 5 * time.Minute
)

// Grace는 deadline이 지난 뒤 process를 끝내기까지 기다리는 시간이다. Context를 따르는
// case는 deadline에 자기 error로 실패하고 정리를 마칠 수 있고, Context를 따르지 않고
// 멈춘 case만 Grace 뒤에 끝난다.
const Grace = 5 * time.Second

var output sync.Mutex

// emit은 보고 줄 하나를 stdout에 쓴다. 여러 goroutine의 줄이 섞이지 않도록 잠근다.
func emit(format string, args ...any) {
	output.Lock()
	defer output.Unlock()
	fmt.Fprintf(os.Stdout, format+"\n", args...)
}

// Case는 실행 중인 case 하나다.
type Case struct {
	name     string
	deadline time.Duration
	started  time.Time
	ctx      context.Context
	cancel   context.CancelFunc
	watchdog *time.Timer
}

// Start는 t를 deadline 아래의 case로 시작하고 RUN 줄을 출력한다. t가 끝나면 PASS, FAIL,
// SKIP 줄을 경과 시간과 함께 출력한다. Context는 deadline에 끝난다. deadline에 Grace를
// 더한 시간이 지나도 끝나지 않으면 FAIL 줄과 모든 goroutine의 stack을 출력하고 test
// binary를 끝낸다. 멈춘 case는 스스로 돌아오지 않기 때문이다.
func Start(t testing.TB, deadline time.Duration) *Case {
	t.Helper()
	if deadline <= 0 {
		t.Fatalf("testcase.Start: deadline %s is not positive", deadline)
	}
	c := &Case{name: t.Name(), deadline: deadline, started: time.Now()}
	c.ctx, c.cancel = context.WithTimeout(context.Background(), deadline)
	emit("RUN %s deadline=%s", c.name, deadline)
	c.watchdog = time.AfterFunc(deadline+Grace, c.expire)
	started.Store(c.name, c)
	t.Cleanup(func() {
		started.Delete(c.name)
		c.watchdog.Stop()
		c.cancel()
		c.finish(t)
	})
	return c
}

// started는 Start로 시작해 아직 끝나지 않은 case를 test 이름으로 찾는다.
var started sync.Map

// Of는 t에 Start한 case나, 없으면 t를 감싼 가장 가까운 test에 Start한 case다. case 값을
// 받지 않는 helper가 자기 단계를 그 case의 STEP 줄로 보고할 때 쓴다. 시작한 case가 없으면
// t를 실패시킨다.
func Of(t testing.TB) *Case {
	t.Helper()
	for name := t.Name(); ; {
		if c, ok := started.Load(name); ok {
			return c.(*Case)
		}
		i := strings.LastIndexByte(name, '/')
		if i < 0 {
			t.Fatalf("testcase.Of: no case started for %s", t.Name())
			return nil
		}
		name = name[:i]
	}
}

// Group은 저마다 Start하는 case를 묶는 test를 시작한다. 묶음 자신은 기한이 없고 시작과
// 결과, 경과 시간만 출력한다.
func Group(t testing.TB) {
	t.Helper()
	c := &Case{name: t.Name(), started: time.Now()}
	emit("RUN %s group", c.name)
	t.Cleanup(func() { c.finish(t) })
}

// Run은 test가 아닌 runner(check 명령)가 case 하나를 같은 형식으로 실행하고 보고한다.
// work는 c.Context()를 따라야 한다. deadline에 Grace를 더한 시간이 지나도 work가 돌아오지
// 않으면 FAIL 줄을 출력하고 error를 돌려준다. work의 error는 FAIL 줄의 이유가 된다.
func Run(name string, deadline time.Duration, work func(c *Case) error) error {
	if deadline <= 0 {
		return fmt.Errorf("testcase.Run %s: deadline %s is not positive", name, deadline)
	}
	c := &Case{name: name, deadline: deadline, started: time.Now()}
	c.ctx, c.cancel = context.WithTimeout(context.Background(), deadline)
	defer c.cancel()
	emit("RUN %s deadline=%s", name, deadline)
	done := make(chan error, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("panic: %v", recovered)
			}
		}()
		done <- work(c)
	}()
	timer := time.NewTimer(deadline + Grace)
	defer timer.Stop()
	var err error
	select {
	case err = <-done:
	case <-timer.C:
		err = fmt.Errorf("deadline %s exceeded", deadline)
	}
	if err != nil {
		emit("FAIL %s elapsed=%s: %v", name, c.elapsed(), err)
		return fmt.Errorf("%s: %w", name, err)
	}
	emit("PASS %s elapsed=%s", name, c.elapsed())
	return nil
}

// RunLong은 test가 아닌 runner가 장기 작업 하나(build, 설치, 도구 실행)를 기한 없이 실행하고
// "RUN <name> no-deadline", 단계, PASS나 FAIL과 경과 시간을 보고한다. 느리지만 정상인 작업이 시계
// 때문에 실패하지 않도록 timer를 두지 않는다. 성공과 실패는 work가 관측한 결과(명령의 종료 코드와
// 오류)로 정한다. c.Context()는 끝나지 않는다.
func RunLong(name string, work func(c *Case) error) error {
	c := &Case{name: name, started: time.Now()}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	defer c.cancel()
	emit("RUN %s no-deadline", name)
	err := func() (err error) {
		defer func() {
			if recovered := recover(); recovered != nil {
				err = fmt.Errorf("panic: %v", recovered)
			}
		}()
		return work(c)
	}()
	if err != nil {
		emit("FAIL %s elapsed=%s: %v", name, c.elapsed(), err)
		return fmt.Errorf("%s: %w", name, err)
	}
	emit("PASS %s elapsed=%s", name, c.elapsed())
	return nil
}

// Step은 case가 지금까지 걸린 시간과 함께 단계 하나를 출력한다. 1분을 넘을 수 있는
// case는 단계마다 Step을 부른다.
func (c *Case) Step(format string, args ...any) {
	emit("STEP %s elapsed=%s: %s", c.name, c.elapsed(), fmt.Sprintf(format, args...))
}

// StepWriter는 쓰인 줄 가운데 빈 줄이 아닌 줄마다 Step 줄 하나를 출력하는 writer다. build 같은 하위 process의
// 진행 출력을 case의 단계로 보인다. process가 끝나면 Flush가 끝 줄을 출력한다.
type StepWriter struct {
	c       *Case
	mu      sync.Mutex
	partial []byte
}

// StepWriter는 c의 단계로 줄을 출력하는 writer를 돌려준다.
func (c *Case) StepWriter() *StepWriter { return &StepWriter{c: c} }

func (w *StepWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.partial = append(w.partial, p...)
	for {
		i := bytes.IndexByte(w.partial, '\n')
		if i < 0 {
			return len(p), nil
		}
		if line := strings.TrimRight(string(w.partial[:i]), "\r"); strings.TrimSpace(line) != "" {
			w.c.Step("%s", line)
		}
		w.partial = w.partial[i+1:]
	}
}

// Flush는 줄 끝 없이 남은 출력을 단계 줄로 출력한다.
func (w *StepWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(bytes.TrimSpace(w.partial)) > 0 {
		w.c.Step("%s", w.partial)
	}
	w.partial = nil
}

// Context는 case의 deadline에 끝나는 context다.
func (c *Case) Context() context.Context { return c.ctx }

// Deadline은 case의 기한이다.
func (c *Case) Deadline() time.Duration { return c.deadline }

func (c *Case) elapsed() time.Duration { return time.Since(c.started).Round(time.Millisecond) }

func (c *Case) finish(t testing.TB) {
	switch {
	case t.Failed():
		emit("FAIL %s elapsed=%s: the errors reported above", c.name, c.elapsed())
	case t.Skipped():
		emit("SKIP %s elapsed=%s", c.name, c.elapsed())
	default:
		emit("PASS %s elapsed=%s", c.name, c.elapsed())
	}
}

// expire는 deadline이 지난 case를 보고하고 process를 끝낸다.
func (c *Case) expire() {
	emit("FAIL %s elapsed=%s: deadline %s exceeded", c.name, c.elapsed(), c.deadline)
	output.Lock()
	_ = pprof.Lookup("goroutine").WriteTo(os.Stderr, 2)
	os.Exit(1)
}
