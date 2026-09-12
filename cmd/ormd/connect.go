package main

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	compilerv1 "github.com/polyspec/orm/proto/orm/compiler/v1"
	compilerbridge "github.com/polyspec/orm/proto/orm/compiler/v1/bridge"
)

type compilerServer struct{ engine *engine.Engine }

func (s *compilerServer) Compile(_ context.Context, req *connect.Request[compilerv1.CompileRequest]) (*connect.Response[compilerv1.CompileResponse], error) {
	input, err := compilerbridge.RequestFromProto(req.Msg)
	if err != nil {
		return connect.NewResponse(compileFailure(err)), nil
	}
	if err := ir.Validate(s.engine.M, input); err != nil {
		return connect.NewResponse(compileFailure(err)), nil
	}
	output, err := s.engine.P.Compile(input)
	if err != nil {
		return connect.NewResponse(compileFailure(err)), nil
	}
	return connect.NewResponse(&compilerv1.CompileResponse{Result: &compilerv1.CompileResponse_Plan{Plan: compilerbridge.PlanToProto(output)}}), nil
}

func compileFailure(err error) *compilerv1.CompileResponse {
	code, message := "INTERNAL", err.Error()
	var compileErr *ir.Error
	if errors.As(err, &compileErr) {
		code, message = compileErr.Code, compileErr.Msg
	}
	return &compilerv1.CompileResponse{Result: &compilerv1.CompileResponse_Error{Error: &compilerv1.CompileError{Code: code, Message: message}}}
}

func (s *compilerServer) GetMetadata(_ context.Context, _ *connect.Request[compilerv1.GetMetadataRequest]) (*connect.Response[compilerv1.GetMetadataResponse], error) {
	return connect.NewResponse(&compilerv1.GetMetadataResponse{SchemaHash: s.engine.M.SchemaHash, Dialect: s.engine.P.D.Name(), IrVersion: ir.Version}), nil
}
