use std::fmt;

use crate::ClientErrorCode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DownloadErrorCode {
    TransientNetwork,
    Integrity,
    Decrypt,
    NotFound,
    AccessRevoked,
    AuthorizationChanged,
    Quota,
    Cancelled,
    IllegalState,
}

impl DownloadErrorCode {
    #[must_use]
    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::TransientNetwork)
    }
}

impl From<DownloadErrorCode> for ClientErrorCode {
    fn from(value: DownloadErrorCode) -> Self {
        match value {
            DownloadErrorCode::Cancelled => Self::OperationCancelled,
            DownloadErrorCode::AccessRevoked | DownloadErrorCode::AuthorizationChanged => {
                Self::DownloadInvalidPlan
            }
            DownloadErrorCode::TransientNetwork
            | DownloadErrorCode::Integrity
            | DownloadErrorCode::Decrypt
            | DownloadErrorCode::NotFound
            | DownloadErrorCode::Quota
            | DownloadErrorCode::IllegalState => Self::DownloadIllegalTransition,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadError {
    pub code: ClientErrorCode,
    pub message: String,
}

impl DownloadError {
    #[must_use]
    pub fn new(code: ClientErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}
