package orm

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/polyspec/orm/engine/ir"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	"github.com/polyspec/orm/proto/orm/compiler/v1/compilerv1connect"
)

type CompilerTransport interface {
	Compile(context.Context, *compilerv1.CompileRequest) (*compilerv1.Plan, error)
	Metadata(context.Context) (*compilerv1.GetMetadataResponse, error)
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
