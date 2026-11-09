//! Nadeshiko API client. The API key is passed as a Bearer token per call.

use std::fmt;
use std::time::Duration;

use reqwest::{redirect::Policy, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const API_BASE: &str = "https://api.nadeshiko.co/v1/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NadeshikoErrorKind {
    InvalidKey,
    RateLimited,
    QuotaExceeded,
    Network,
    InvalidResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoError {
    pub kind: NadeshikoErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl fmt::Display for NadeshikoErrorKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidKey => "invalid-key",
            Self::RateLimited => "rate-limited",
            Self::QuotaExceeded => "quota-exceeded",
            Self::Network => "network",
            Self::InvalidResponse => "invalid-response",
        })
    }
}

impl NadeshikoError {
    fn new(
        kind: NadeshikoErrorKind,
        status: Option<u16>,
        retry_after_seconds: Option<u64>,
    ) -> Self {
        let message = match kind {
            NadeshikoErrorKind::InvalidKey => "Nadeshiko API key is invalid",
            NadeshikoErrorKind::RateLimited => "Nadeshiko rate limit exceeded",
            NadeshikoErrorKind::QuotaExceeded => "Nadeshiko monthly quota exceeded",
            NadeshikoErrorKind::Network => "Nadeshiko network request failed",
            NadeshikoErrorKind::InvalidResponse => "Nadeshiko returned an invalid response",
        };
        Self {
            kind,
            message: message.to_string(),
            retry_after_seconds,
            status,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoSegment {
    pub id: String,
    pub work_name: String,
    pub line: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub english_translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spanish_translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_public_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight_ja: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight_en: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urls: Option<NadeshikoSegmentUrls>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoSegmentUrls {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoSearchPage {
    pub segments: Vec<NadeshikoSegment>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_total_hits: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_total_hits_relation: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoSearchOptions {
    pub take: Option<u32>,
    pub mode: Option<String>,
    pub seed: Option<i64>,
    pub exact_match: Option<bool>,
    pub cursor: Option<String>,
    pub include: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoContextOptions {
    pub take: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoSegmentContextResponse {
    pub center: NadeshikoSegment,
    pub surrounding: Vec<NadeshikoSegment>,
    pub center_idx: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NadeshikoUserMe {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<NadeshikoUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<NadeshikoQuota>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoUser {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NadeshikoQuota {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_yyyymm: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_end: Option<String>,
}

#[derive(Clone)]
pub struct NadeshikoClient {
    client: Client,
    base_url: Url,
}

impl NadeshikoClient {
    pub fn new() -> Self {
        Self::with_base_url(API_BASE).expect("the built-in Nadeshiko API URL is valid")
    }

    /// Construct a client for a trusted alternate endpoint, primarily used by
    /// local mock-server tests. This is not exposed through the Tauri IPC.
    #[doc(hidden)]
    pub fn with_base_url(base_url: &str) -> Result<Self, NadeshikoError> {
        let base_url = Url::parse(base_url)
            .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::Network, None, None))?;
        if !matches!(base_url.scheme(), "https" | "http") || base_url.host_str().is_none() {
            return Err(NadeshikoError::new(NadeshikoErrorKind::Network, None, None));
        }
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::Network, None, None))?;
        Ok(Self { client, base_url })
    }

    pub async fn search(
        &self,
        api_key: &str,
        query: &str,
        options: NadeshikoSearchOptions,
    ) -> Result<NadeshikoSearchPage, NadeshikoError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(empty_page());
        }
        let mut nested = Map::new();
        nested.insert("search".into(), Value::String(query.to_string()));
        if let Some(exact_match) = options.exact_match {
            nested.insert("exactMatch".into(), Value::Bool(exact_match));
        }
        let mut sort = Map::new();
        sort.insert(
            "mode".into(),
            Value::String(options.mode.unwrap_or_else(|| "RELEVANCE".into())),
        );
        if let Some(seed) = options.seed {
            sort.insert("seed".into(), Value::Number(seed.into()));
        }
        let mut body = Map::new();
        body.insert("query".into(), Value::Object(nested));
        body.insert(
            "take".into(),
            Value::Number(options.take.unwrap_or(10).into()),
        );
        body.insert("sort".into(), Value::Object(sort));
        if let Some(cursor) = options.cursor {
            body.insert("cursor".into(), Value::String(cursor));
        }
        if let Some(include) = options.include.filter(|values| !values.is_empty()) {
            let include = serde_json::to_value(include).map_err(|_| {
                NadeshikoError::new(NadeshikoErrorKind::InvalidResponse, None, None)
            })?;
            body.insert("include".into(), include);
        }
        let url = self.endpoint(&["search"])?;
        let data = self
            .request_json(api_key, self.client.post(url).json(&Value::Object(body)))
            .await?;
        Ok(parse_search_page(&data))
    }

    pub async fn segment_context(
        &self,
        api_key: &str,
        segment_id: &str,
        options: NadeshikoContextOptions,
    ) -> Result<NadeshikoSegmentContextResponse, NadeshikoError> {
        let mut url = self.endpoint(&["media", "segments"])?;
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::Network, None, None))?;
            path.push(segment_id);
            path.push("context");
        }
        url.query_pairs_mut().append_pair("include", "media");
        if let Some(take) = options.take {
            url.query_pairs_mut().append_pair("take", &take.to_string());
        }
        let data = self.request_json(api_key, self.client.get(url)).await?;
        Ok(parse_context(&data, segment_id))
    }

    pub async fn user_me(&self, api_key: &str) -> Result<NadeshikoUserMe, NadeshikoError> {
        let url = self.endpoint(&["user", "me"])?;
        let data = self.request_json(api_key, self.client.get(url)).await?;
        serde_json::from_value(data)
            .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::InvalidResponse, None, None))
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, NadeshikoError> {
        let mut url = self.base_url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::Network, None, None))?;
            path.pop_if_empty();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }

    async fn request_json(
        &self,
        api_key: &str,
        request: reqwest::RequestBuilder,
    ) -> Result<Value, NadeshikoError> {
        let response = request
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::Network, None, None))?;
        if !response.status().is_success() {
            return Err(classify_response(response).await);
        }
        response
            .json::<Value>()
            .await
            .map_err(|_| NadeshikoError::new(NadeshikoErrorKind::InvalidResponse, None, None))
    }
}

impl Default for NadeshikoClient {
    fn default() -> Self {
        Self::new()
    }
}

fn empty_page() -> NadeshikoSearchPage {
    NadeshikoSearchPage {
        segments: Vec::new(),
        has_more: false,
        next_cursor: None,
        estimated_total_hits: None,
        estimated_total_hits_relation: None,
    }
}

fn parse_search_page(data: &Value) -> NadeshikoSearchPage {
    let Some(object) = data.as_object() else {
        return empty_page();
    };
    let Some(raw_segments) = object.get("segments").and_then(Value::as_array) else {
        return empty_page();
    };
    let names = work_name_map(object.get("includes"));
    let segments = raw_segments
        .iter()
        .filter_map(|raw| normalize_segment(raw, &names))
        .collect();
    let pagination = object.get("pagination").and_then(Value::as_object);
    let has_more = pagination
        .and_then(|p| p.get("hasMore"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cursor = pagination
        .and_then(|p| p.get("cursor"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let has_more = has_more && cursor.is_some();
    let estimated_total_hits = pagination
        .and_then(|p| p.get("estimatedTotalHits"))
        .and_then(Value::as_u64);
    let estimated_total_hits_relation = pagination
        .and_then(|p| p.get("estimatedTotalHitsRelation"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "EXACT" | "AT_LEAST"))
        .map(str::to_string);
    NadeshikoSearchPage {
        segments,
        has_more,
        next_cursor: if has_more { cursor } else { None },
        estimated_total_hits,
        estimated_total_hits_relation,
    }
}

fn parse_context(data: &Value, segment_id: &str) -> NadeshikoSegmentContextResponse {
    let Some(object) = data.as_object() else {
        return fallback_context(segment_id);
    };
    let names = work_name_map(object.get("includes"));
    let all: Vec<NadeshikoSegment> = object
        .get("segments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|raw| normalize_segment(raw, &names))
        .collect();
    let Some(center_idx) = all.iter().position(|segment| segment.id == segment_id) else {
        let center = all
            .first()
            .cloned()
            .unwrap_or_else(|| placeholder_segment(segment_id));
        return NadeshikoSegmentContextResponse {
            center,
            surrounding: all.into_iter().skip(1).collect(),
            center_idx: 0,
        };
    };
    let center = all
        .get(center_idx)
        .cloned()
        .unwrap_or_else(|| placeholder_segment(segment_id));
    let surrounding = all
        .into_iter()
        .enumerate()
        .filter_map(|(index, segment)| (index != center_idx).then_some(segment))
        .collect();
    NadeshikoSegmentContextResponse {
        center,
        surrounding,
        center_idx: center_idx as i64,
    }
}

fn fallback_context(segment_id: &str) -> NadeshikoSegmentContextResponse {
    NadeshikoSegmentContextResponse {
        center: placeholder_segment(segment_id),
        surrounding: Vec::new(),
        center_idx: -1,
    }
}

fn placeholder_segment(id: &str) -> NadeshikoSegment {
    NadeshikoSegment {
        id: id.to_string(),
        work_name: String::new(),
        line: String::new(),
        english_translation: None,
        spanish_translation: None,
        timestamp_seconds: None,
        timestamp_label: None,
        episode: None,
        position: None,
        media_public_id: None,
        highlight_ja: None,
        highlight_en: None,
        image_url: None,
        audio_url: None,
        urls: None,
    }
}

fn normalize_segment(
    raw: &Value,
    names: &std::collections::HashMap<String, String>,
) -> Option<NadeshikoSegment> {
    let object = raw.as_object()?;
    let id = pick_string(object, &["publicId", "id", "segmentId"])?;
    let text_ja = object.get("textJa").and_then(Value::as_object);
    let text_en = object.get("textEn").and_then(Value::as_object);
    let text_es = object.get("textEs").and_then(Value::as_object);
    let line = text_ja
        .and_then(|v| pick_string(v, &["content", "text"]))
        .unwrap_or_default();
    let start_ms = pick_number(object, &["startTimeMs", "startTime"]);
    let timestamp_seconds = start_ms
        .map(|v| v / 1000.0)
        .or_else(|| pick_number(object, &["timestampSeconds", "startSeconds"]));
    let timestamp_label = format_timestamp(start_ms, timestamp_seconds);
    let media_public_id = pick_string(object, &["mediaPublicId"]);
    let work_name = media_public_id
        .as_ref()
        .and_then(|key| names.get(key))
        .cloned()
        .unwrap_or_default();
    let urls_object = object.get("urls").and_then(Value::as_object);
    let urls = urls_object.map(|urls| NadeshikoSegmentUrls {
        image_url: pick_string(urls, &["imageUrl"]),
        audio_url: pick_string(urls, &["audioUrl"]),
        video_url: pick_string(urls, &["videoUrl"]),
    });
    let image_url = urls.as_ref().and_then(|value| value.image_url.clone());
    let audio_url = urls.as_ref().and_then(|value| value.audio_url.clone());
    Some(NadeshikoSegment {
        id,
        work_name,
        line,
        english_translation: text_en.and_then(|v| pick_string(v, &["content"])),
        spanish_translation: text_es.and_then(|v| pick_string(v, &["content"])),
        timestamp_seconds,
        timestamp_label,
        episode: object.get("episode").and_then(Value::as_i64),
        position: object.get("position").and_then(Value::as_i64),
        media_public_id,
        highlight_ja: text_ja.and_then(|v| pick_string(v, &["highlight"])),
        highlight_en: text_en.and_then(|v| pick_string(v, &["highlight"])),
        image_url,
        audio_url,
        urls,
    })
}

fn work_name_map(includes: Option<&Value>) -> std::collections::HashMap<String, String> {
    let mut names = std::collections::HashMap::new();
    let Some(media) = includes
        .and_then(Value::as_object)
        .and_then(|v| v.get("media"))
        .and_then(Value::as_object)
    else {
        return names;
    };
    for (id, raw) in media {
        if let Some(media) = raw.as_object() {
            if let Some(name) = pick_string(media, &["nameJa", "nameEn", "nameRomaji"]) {
                names.insert(id.clone(), name);
            }
        }
    }
    names
}

fn pick_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn pick_number(object: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let value = object.get(*key)?;
        let number = value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))?;
        number.is_finite().then_some(number)
    })
}

fn format_timestamp(start_ms: Option<f64>, seconds: Option<f64>) -> Option<String> {
    let total = start_ms
        .map(|value| (value / 1000.0).floor())
        .or_else(|| seconds.map(f64::floor))?;
    if !total.is_finite() {
        return None;
    }
    let total = total.max(0.0) as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        Some(format!("{hours}:{minutes:02}:{seconds:02}"))
    } else {
        Some(format!("{minutes}:{seconds:02}"))
    }
}

async fn classify_response(response: reqwest::Response) -> NadeshikoError {
    let status = response.status();
    let retry_after_seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return NadeshikoError::new(NadeshikoErrorKind::InvalidKey, Some(status.as_u16()), None);
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        let body = response.json::<Value>().await.ok();
        let kind = if body
            .as_ref()
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            == Some("QUOTA_EXCEEDED")
        {
            NadeshikoErrorKind::QuotaExceeded
        } else {
            NadeshikoErrorKind::RateLimited
        };
        return NadeshikoError::new(
            kind,
            Some(status.as_u16()),
            if kind == NadeshikoErrorKind::RateLimited {
                retry_after_seconds
            } else {
                None
            },
        );
    }
    NadeshikoError::new(NadeshikoErrorKind::Network, Some(status.as_u16()), None)
}

fn parse_retry_after(value: &str) -> Option<u64> {
    if let Ok(seconds) = value.parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.0).then(|| seconds.ceil() as u64);
    }
    let date = httpdate::parse_http_date(value).ok()?;
    date.duration_since(std::time::SystemTime::now())
        .ok()
        .map(|duration| {
            duration
                .as_secs()
                .saturating_add(u64::from(duration.subsec_nanos() > 0))
        })
}
