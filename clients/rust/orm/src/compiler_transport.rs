use std::time::Duration;

use async_trait::async_trait;
use prost::Message;

use crate::compiler_proto::{
    compile_response, CompileRequest, CompileResponse, GetMetadataRequest, GetMetadataResponse,
    Plan,
};
use crate::{Error, Result};

const SERVICE: &str = "/orm.compiler.v1.CompilerService/";

#[async_trait]
pub trait CompilerTransport: Send + Sync {
    async fn compile(&self, request: CompileRequest) -> Result<Plan>;
    async fn metadata(&self) -> Result<GetMetadataResponse>;
}

pub struct ConnectCompiler {
    endpoint: String,
    client: reqwest::Client,
}

impl ConnectCompiler {
    pub fn new(endpoint: &str, timeout: Duration) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint)
            .map_err(|error| Error::Config(format!("compiler endpoint: {error}")))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(Error::Config(
                "compiler endpoint must use http:// or https://".into(),
            ));
        }
        if timeout.is_zero() {
            return Err(Error::Config("compiler timeout must be positive".into()));
        }
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| Error::Config(format!("compiler HTTP client: {error}")))?;
        Ok(Self {
            endpoint: endpoint.trim_end_matches('/').into(),
            client,
        })
    }

    async fn call<I: Message, O: Message + Default>(&self, method: &str, request: I) -> Result<O> {
        let response = self
            .client
            .post(format!("{}{}{}", self.endpoint, SERVICE, method))
            .header("Content-Type", "application/proto")
            .header("Accept", "application/proto")
            .header("Connect-Protocol-Version", "1")
            .body(request.encode_to_vec())
            .send()
            .await
            .map_err(|error| Error::Config(format!("compiler RPC {method}: {error}")))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| Error::Config(format!("compiler RPC {method} response: {error}")))?;
        if !status.is_success() {
            return Err(Error::Config(format!(
                "compiler RPC {method} failed: HTTP {}: {}",
                status.as_u16(),
                String::from_utf8_lossy(&body)
            )));
        }
        O::decode(body)
            .map_err(|error| Error::Config(format!("compiler RPC {method} protobuf: {error}")))
    }
}

#[async_trait]
impl CompilerTransport for ConnectCompiler {
    async fn compile(&self, request: CompileRequest) -> Result<Plan> {
        let response: CompileResponse = self.call("Compile", request).await?;
        match response.result {
            Some(compile_response::Result::Plan(plan)) => Ok(plan),
            Some(compile_response::Result::Error(error)) => Err(Error::Engine {
                code: error.code,
                msg: error.message,
            }),
            None => Err(Error::Config("compiler returned no plan or error".into())),
        }
    }

    async fn metadata(&self) -> Result<GetMetadataResponse> {
        self.call("GetMetadata", GetMetadataRequest {}).await
    }
}
