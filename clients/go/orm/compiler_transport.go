package orm

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	compilerbridge "github.com/polyspec/orm/proto/orm/compiler/v1/bridge"
	"github.com/polyspec/orm/proto/orm/compiler/v1/compilerv1connect"
)

type CompilerTransport interface {
	Compile(context.Context, *compilerv1.CompileRequest) (*compilerv1.Plan, error)
	Metadata(context.Context) (*compilerv1.GetMetadataResponse, error)
}

type planCompiler interface {
	Compile(context.Context, *ir.Request) (*plan.Plan, error)
	Metadata(context.Context) (*compilerv1.GetMetadataResponse, error)
}

type transportPlanCompiler struct{ transport CompilerTransport }

func (c transportPlanCompiler) Compile(ctx context.Context, request *ir.Request) (*plan.Plan, error) {
	wire, err := compilerbridge.RequestToProto(request)
	if err != nil {
		return nil, err
	}
	compiled, err := c.transport.Compile(ctx, wire)
	if err != nil {
		return nil, err
	}
	return compilerbridge.PlanFromProto(compiled)
}

func (c transportPlanCompiler) Metadata(ctx context.Context) (*compilerv1.GetMetadataResponse, error) {
	return c.transport.Metadata(ctx)
}

type enginePlanCompiler struct{ engine *engine.Engine }

func (c enginePlanCompiler) Compile(_ context.Context, request *ir.Request) (*plan.Plan, error) {
	if err := ir.Validate(c.engine.M, request); err != nil {
		return nil, err
	}
	return c.engine.P.Compile(request)
}

func (c enginePlanCompiler) Metadata(context.Context) (*compilerv1.GetMetadataResponse, error) {
	return &compilerv1.GetMetadataResponse{SchemaHash: c.engine.M.SchemaHash, Dialect: c.engine.P.D.Name(), IrVersion: ir.Version}, nil
}

type ConnectCompiler struct {
	client compilerv1connect.CompilerServiceClient
}

var _ CompilerTransport = (*ConnectCompiler)(nil)

func NewConnectCompiler(endpoint string, timeout time.Duration) (*ConnectCompiler, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("CONFIG: compiler endpoint must use http:// or https://")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("CONFIG: compiler timeout must be positive")
	}
	client := &http.Client{Timeout: timeout}
	return &ConnectCompiler{client: compilerv1connect.NewCompilerServiceClient(client, strings.TrimRight(endpoint, "/"))}, nil
}

func (c *ConnectCompiler) Compile(ctx context.Context, request *compilerv1.CompileRequest) (*compilerv1.Plan, error) {
	response, err := c.client.Compile(ctx, connect.NewRequest(request))
	if err != nil {
		return nil, fmt.Errorf("CONFIG: compiler RPC Compile: %w", err)
	}
	if compileErr := response.Msg.GetError(); compileErr != nil {
		return nil, &ir.Error{Code: compileErr.Code, Msg: compileErr.Message}
	}
	if response.Msg.GetPlan() == nil {
		return nil, fmt.Errorf("INTERNAL: compiler returned no plan or error")
	}
	return response.Msg.GetPlan(), nil
}

func (c *ConnectCompiler) Metadata(ctx context.Context) (*compilerv1.GetMetadataResponse, error) {
	response, err := c.client.GetMetadata(ctx, connect.NewRequest(&compilerv1.GetMetadataRequest{}))
	if err != nil {
		return nil, fmt.Errorf("CONFIG: compiler RPC GetMetadata: %w", err)
	}
	return response.Msg, nil
}
