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
            DownloadErrorCode::TransientNetwork => Self::DownloadTransientNetwork,
            DownloadErrorCode::Integrity => Self::DownloadIntegrity,
            DownloadErrorCode::Decrypt => Self::DownloadDecrypt,
            DownloadErrorCode::NotFound => Self::DownloadNotFound,
            DownloadErrorCode::AccessRevoked => Self::DownloadAccessRevoked,
            DownloadErrorCode::AuthorizationChanged => Self::DownloadAuthorizationChanged,
            DownloadErrorCode::Quota => Self::DownloadQuota,
            DownloadErrorCode::Cancelled => Self::DownloadCancelled,
            DownloadErrorCode::IllegalState => Self::DownloadIllegalState,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_error_codes_map_to_dedicated_client_codes() {
        let cases = [
            (
                DownloadErrorCode::TransientNetwork,
                ClientErrorCode::DownloadTransientNetwork,
            ),
            (
                DownloadErrorCode::Integrity,
                ClientErrorCode::DownloadIntegrity,
            ),
            (DownloadErrorCode::Decrypt, ClientErrorCode::DownloadDecrypt),
            (
                DownloadErrorCode::NotFound,
                ClientErrorCode::DownloadNotFound,
            ),
            (
                DownloadErrorCode::AccessRevoked,
                ClientErrorCode::DownloadAccessRevoked,
            ),
            (
                DownloadErrorCode::AuthorizationChanged,
                ClientErrorCode::DownloadAuthorizationChanged,
            ),
            (DownloadErrorCode::Quota, ClientErrorCode::DownloadQuota),
            (
                DownloadErrorCode::Cancelled,
                ClientErrorCode::DownloadCancelled,
            ),
            (
                DownloadErrorCode::IllegalState,
                ClientErrorCode::DownloadIllegalState,
            ),
        ];

        for (download_code, client_code) in cases {
            assert_eq!(ClientErrorCode::from(download_code), client_code);
        }
    }
}
