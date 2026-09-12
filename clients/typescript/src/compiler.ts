import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import {
  CompileRequestSchema,
  CompilerService,
  GetMetadataRequestSchema,
  type CompileRequest,
  type GetMetadataResponse,
  type Plan,
} from './gen/proto/orm/compiler/v1/compiler_pb.js';

export function compileRequest(init: MessageInitShape<typeof CompileRequestSchema>): CompileRequest {
  return create(CompileRequestSchema, init);
}

export class CompilerError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CompilerError';
  }
}

export interface CompilerTransport {
  compile(request: CompileRequest): Promise<Plan>;
  metadata(): Promise<GetMetadataResponse>;
}

export class ConnectCompiler implements CompilerTransport {
  private readonly client: Client<typeof CompilerService>;
  private readonly timeoutMs: number;

  public constructor(endpoint: string, timeoutMs = 5_000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CompilerError('CONFIG', 'compiler endpoint must use http:// or https://');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new CompilerError('CONFIG', 'compiler timeout must be a positive integer');
    this.timeoutMs = timeoutMs;
    this.client = createClient(CompilerService, createConnectTransport({ baseUrl: url.toString().replace(/\/$/, ''), useBinaryFormat: true, httpVersion: '1.1' }));
  }

  public async compile(request: CompileRequest): Promise<Plan> {
    const response = await this.client.compile(request, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.result.case === 'error') throw new CompilerError(response.result.value.code, response.result.value.message);
    if (response.result.case !== 'plan') throw new CompilerError('INTERNAL', 'compiler returned no plan or error');
    return response.result.value;
  }

  public metadata(): Promise<GetMetadataResponse> {
    return this.client.getMetadata(create(GetMetadataRequestSchema), { signal: AbortSignal.timeout(this.timeoutMs) });
  }
}
