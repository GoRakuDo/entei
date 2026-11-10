//! Jimaku API client. The API uses a raw Authorization key (no Bearer prefix).

use std::net::IpAddr;
use std::time::Duration;

use reqwest::{redirect::Policy, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use url::Host;

const API_BASE: &str = "https://jimaku.cc/api/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JimakuEntry {
    pub id: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anilist_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmdb_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub english_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub japanese_name: Option<String>,
    #[serde(default)]
    pub flags: JimakuEntryFlags,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct JimakuEntryFlags {
    #[serde(default)]
    pub anime: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adult: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub movie: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unverified: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JimakuFile {
    pub url: String,
    pub name: String,
    pub size: u64,
    pub last_modified: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JimakuErrorKind {
    Auth,
    NotFound,
    RateLimit,
    Network,
    Empty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JimakuError {
    pub kind: JimakuErrorKind,
    pub message: String,
}

impl JimakuError {
    fn new(kind: JimakuErrorKind) -> Self {
        let message = match kind {
            JimakuErrorKind::Auth => "Jimaku authentication failed",
            JimakuErrorKind::NotFound => "Jimaku resource was not found",
            JimakuErrorKind::RateLimit => "Jimaku rate limit exceeded",
            JimakuErrorKind::Network => "Jimaku network request failed",
            JimakuErrorKind::Empty => "Jimaku returned no results",
        };
        Self {
            kind,
            message: message.to_string(),
        }
    }
}

pub type JimakuResult<T> = Result<T, JimakuError>;

#[derive(Clone)]
pub struct JimakuClient {
    client: Client,
    base_url: Url,
}

impl JimakuClient {
    pub fn new() -> Self {
        Self::with_base_url(API_BASE).expect("the built-in Jimaku API URL is valid")
    }

    /// Construct a client for a trusted alternate endpoint, primarily used by
    /// local mock-server tests. This is not exposed through the Tauri IPC.
    #[doc(hidden)]
    pub fn with_base_url(base_url: &str) -> JimakuResult<Self> {
        let base_url =
            Url::parse(base_url).map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
        if !matches!(base_url.scheme(), "https" | "http") || base_url.host_str().is_none() {
            return Err(JimakuError::new(JimakuErrorKind::Network));
        }
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .no_proxy()
            // Do not forward the authenticated API request through a redirect.
            .redirect(Policy::none())
            .build()
            .map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
        Ok(Self { client, base_url })
    }

    pub async fn search_entries(
        &self,
        api_key: &str,
        query: &str,
        anime: bool,
    ) -> JimakuResult<Vec<JimakuEntry>> {
        let mut url = self.endpoint(&["entries", "search"])?;
        url.query_pairs_mut()
            .append_pair("query", query.trim())
            .append_pair("anime", if anime { "true" } else { "false" });
        let entries: Vec<JimakuEntry> = self.authenticated_get_json(api_key, url).await?;
        if entries.is_empty() {
            return Err(JimakuError::new(JimakuErrorKind::Empty));
        }
        Ok(entries)
    }

    /// Search anime and drama concurrently. A successful side is retained
    /// when the other side fails; only two failures produce an error.
    pub async fn search_entries_combined(
        &self,
        api_key: &str,
        query: &str,
    ) -> JimakuResult<Vec<JimakuEntry>> {
        let (anime, drama) = tokio::join!(
            self.search_entries(api_key, query, true),
            self.search_entries(api_key, query, false),
        );
        let mut entries = Vec::new();
        let mut errors = Vec::new();
        match anime {
            Ok(found) => entries.extend(found),
            Err(error) => errors.push(error),
        }
        match drama {
            Ok(found) => entries.extend(found),
            Err(error) => errors.push(error),
        }
        if entries.is_empty() {
            return Err(errors
                .into_iter()
                .find(|error| error.kind != JimakuErrorKind::Empty)
                .unwrap_or_else(|| JimakuError::new(JimakuErrorKind::Empty)));
        }
        entries.sort_by(|left, right| compare_entry_names(&left.name, &right.name));
        entries.dedup_by_key(|entry| entry.id);
        Ok(entries)
    }

    pub async fn entry_files(
        &self,
        api_key: &str,
        entry_id: i64,
        episode: Option<u32>,
    ) -> JimakuResult<Vec<JimakuFile>> {
        if entry_id < 0 {
            return Err(JimakuError::new(JimakuErrorKind::NotFound));
        }
        let mut url = self.endpoint(&["entries", &entry_id.to_string(), "files"])?;
        if let Some(episode) = episode {
            url.query_pairs_mut()
                .append_pair("episode", &episode.to_string());
        }
        let files: Vec<JimakuFile> = self.authenticated_get_json(api_key, url).await?;
        if files.is_empty() {
            return Err(JimakuError::new(JimakuErrorKind::Empty));
        }
        Ok(files)
    }

    /// Download a subtitle from the public URL returned by Jimaku.
    /// HTTPS is mandatory, redirects are bounded and cannot downgrade to HTTP
    /// or point at a loopback/private IP address.
    pub async fn download_subtitle(&self, download_url: &str) -> JimakuResult<String> {
        let url =
            Url::parse(download_url).map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
        if !is_public_https_url(&url) {
            return Err(JimakuError::new(JimakuErrorKind::Network));
        }
        let client = Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .user_agent("Entei/0.1")
            .no_proxy()
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 || !is_public_https_url(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
        let response = client
            .get(url)
            .header("User-Agent", "Entei/0.1")
            .send()
            .await
            .map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(JimakuError::new(JimakuErrorKind::NotFound));
        }
        if !response.status().is_success() {
            return Err(JimakuError::new(classify_status(response.status())));
        }
        const MAX_SUBTITLE_BYTES: usize = 10 * 1024 * 1024;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_SUBTITLE_BYTES as u64)
        {
            return Err(JimakuError::new(JimakuErrorKind::Network));
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| JimakuError::new(JimakuErrorKind::Network))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_SUBTITLE_BYTES {
                return Err(JimakuError::new(JimakuErrorKind::Network));
            }
            body.extend_from_slice(&chunk);
        }
        String::from_utf8(body).map_err(|_| JimakuError::new(JimakuErrorKind::Network))
    }

    fn endpoint(&self, segments: &[&str]) -> JimakuResult<Url> {
        let mut url = self.base_url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    async fn authenticated_get_json<T: serde::de::DeserializeOwned>(
        &self,
        api_key: &str,
        url: Url,
    ) -> JimakuResult<T> {
        let response = self
            .client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, api_key)
            .header("X-Client-Id", "Entei/0.1")
            .send()
            .await
            .map_err(|_| JimakuError::new(JimakuErrorKind::Network))?;
        if !response.status().is_success() {
            return Err(JimakuError::new(classify_status(response.status())));
        }
        response
            .json()
            .await
            .map_err(|_| JimakuError::new(JimakuErrorKind::Network))
    }
}

impl Default for JimakuClient {
    fn default() -> Self {
        Self::new()
    }
}

fn compare_entry_names(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (Some(left), Some(right)) if left.is_ascii_digit() && right.is_ascii_digit() => {
                let mut left_digits = String::new();
                let mut right_digits = String::new();
                while left_chars.peek().is_some_and(char::is_ascii_digit) {
                    if let Some(digit) = left_chars.next() {
                        left_digits.push(digit);
                    }
                }
                while right_chars.peek().is_some_and(char::is_ascii_digit) {
                    if let Some(digit) = right_chars.next() {
                        right_digits.push(digit);
                    }
                }
                let left_value = left_digits.trim_start_matches('0');
                let right_value = right_digits.trim_start_matches('0');
                let order = left_value
                    .len()
                    .cmp(&right_value.len())
                    .then_with(|| left_value.cmp(right_value));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(left), Some(right)) => {
                let order = left.to_lowercase().cmp(right.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left_chars.next();
                right_chars.next();
            }
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (None, None) => return Ordering::Equal,
        }
    }
}

fn classify_status(status: StatusCode) -> JimakuErrorKind {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => JimakuErrorKind::Auth,
        StatusCode::NOT_FOUND => JimakuErrorKind::NotFound,
        StatusCode::TOO_MANY_REQUESTS => JimakuErrorKind::RateLimit,
        _ => JimakuErrorKind::Network,
    }
}

fn is_public_https_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    if let Some(host) = url.host_str() {
        if host.eq_ignore_ascii_case("localhost")
            || host.to_ascii_lowercase().ends_with(".localhost")
        {
            return false;
        }
    }
    match url.host() {
        Some(Host::Ipv4(address)) => !is_private_ip(address.into()),
        Some(Host::Ipv6(address)) => !is_private_ip(address.into()),
        Some(Host::Domain(host)) => {
            !host.eq_ignore_ascii_case("localhost")
                && !host.to_ascii_lowercase().ends_with(".localhost")
        }
        None => false,
    }
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|mapped| is_private_ip(IpAddr::V4(mapped)))
                || ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
        }
    }
}
