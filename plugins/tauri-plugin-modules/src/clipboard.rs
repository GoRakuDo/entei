//! OS clipboard TEXT read — the native half of `/search/`'s clipboard monitor.
//!
//! One direction only: this module never writes, never clears and never keeps a
//! clipboard handle alive between calls. The Yomitan search page polls it twice a
//! second whether or not its window has focus
//! (`modules/yomitan/search/use-clipboard-monitor.ts`), so a read has to be cheap,
//! self-contained and — above all — unable to fail the
//! page: a clipboard that is empty, holds an image, or is locked by another
//! process answers "nothing to search", never an error.
//!
//! PLATFORM SPLIT. `arboard` is the desktop clipboard (Windows, Linux/X11 and
//! Wayland, macOS), and it is deliberately taken with
//! `default-features = false`: the image half of that crate is never used here,
//! and dropping it keeps the C-free, small dependency this host wants. `arboard`
//! has **no Android implementation at all** — its `src/platform/mod.rs` exports
//! nothing for `target_os = "android"`, so the crate does not even compile there
//! (see `Cargo.toml`, where the dependency is target-gated). Android therefore
//! goes through `jni` against `android.content.ClipboardManager`, the same route
//! every Tauri mobile clipboard plugin takes.
//!
//! ANDROID FOCUS. `getPrimaryClip()` is only handed out to the app that
//! currently has input focus (Android 10 / API 29 and later). That is a platform
//! rule, not a bug here: the caller polls on a timer regardless and simply gets
//! "nothing" while the app is in the background, which is why this function
//! answers "nothing" instead of raising — a monitor that failed there would stop
//! following the clipboard for good.

/// Blank means "nothing to search", at the one place that decides it.
///
/// Every platform hands back its own kind of nothing — `arboard` answers `Err`
/// for an empty or non-text clipboard, the JNI path answers a null `ClipData` —
/// and an empty string is the same answer again. Normalising here keeps the
/// command's contract to one sentence: `None` = do not touch the search field.
fn non_empty(text: Option<String>) -> Option<String> {
    match text {
        Some(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

/// The clipboard's plain text, or `None` when there is nothing to search.
///
/// A fresh handle per call on purpose. Windows' clipboard is a global object that
/// only one thread may hold at a time, so `arboard` opens it per operation and
/// closes it on drop; keeping one alive would hold the clipboard against every
/// other application. Nothing here may panic out to the caller — see `non_empty`.
pub fn read_plain_text() -> Option<String> {
    non_empty(read_platform())
}

/// Platform read. Answers `None` for every kind of "no text available".
#[cfg(not(target_os = "android"))]
fn read_platform() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

/// The Android `Context` wrapper, imported at MODULE level because it appears in
/// [`read_clipboard_text`]'s SIGNATURE — a `use` inside a function body is not
/// visible to that function's own signature.
#[cfg(target_os = "android")]
use jni::objects::JObject;

/// Platform read through `android.content.ClipboardManager`.
///
/// The whole chain is `Option`-shaped: an unset `ndk_context` (the app is not
/// running under an `Activity`), a missing clipboard service, a non-text primary
/// clip (an image, an intent, a URI) and a Java exception all read as "nothing",
/// because a search page that stops polling is worse than one that skips a sample.
///
/// `ctx.context()` is a *global* reference to the host `Context` (in practice the
/// `NativeActivity`), published by `ndk-glue` at startup, so it is legal to use it
/// from the blocking-pool thread this runs on.
#[cfg(target_os = "android")]
fn read_platform() -> Option<String> {
    use jni::JavaVM;

    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return None;
    }
    // Borrowed, never owned: `from_raw` only null-checks, and dropping this value
    // must never destroy the VM the process is running in.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    // Scoped: the guard detaches this thread again, so a blocking-pool thread that
    // outlives the call does not stay attached (an attached thread blocks VM exit).
    let mut env = vm.attach_current_thread().ok()?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    read_clipboard_text(&mut env, &context).ok().flatten()
}

/// One clipboard read against an attached JVM.
#[cfg(target_os = "android")]
fn read_clipboard_text<'env>(
    env: &mut jni::JNIEnv<'env>,
    context: &JObject<'env>,
) -> jni::errors::Result<Option<String>> {
    use jni::objects::{JString, JValue};

    let service = env.new_string("clipboard")?;
    let manager = env
        .call_method(
            context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service)],
        )?
        .l()?;
    if manager.is_null() {
        return Ok(None);
    }
    let clips = env
        .call_method(
            &manager,
            "getPrimaryClip",
            "()Landroid/content/ClipData;",
            &[],
        )?
        .l()?;
    if clips.is_null() {
        return Ok(None);
    }
    let count = env.call_method(&clips, "getItemCount", "()I", &[])?.i()?;
    if count <= 0 {
        return Ok(None);
    }
    let item = env
        .call_method(
            &clips,
            "getItemAt",
            "(I)Landroid/content/ClipData$Item;",
            &[JValue::Int(0)],
        )?
        .l()?;
    if item.is_null() {
        return Ok(None);
    }
    // `ClipData.Item.getText()` is nullable (a URI or intent item has none), and
    // what it returns is a `CharSequence` — `toString()` is what makes it a
    // `java.lang.String` this side can decode.
    let chars = env
        .call_method(&item, "getText", "()Ljava/lang/CharSequence;", &[])?
        .l()?;
    if chars.is_null() {
        return Ok(None);
    }
    let text = env
        .call_method(&chars, "toString", "()Ljava/lang/String;", &[])?
        .l()?;
    if text.is_null() {
        return Ok(None);
    }
    let text: JString = text.into();
    /* `.into()`, NOT `to_string_lossy()`.
     *
     * A Java `String` reaches JNI as MODIFIED UTF-8 (CESU-8), so every scalar
     * outside the BMP — an emoji, a non-BMP kanji such as 𠮷 — arrives as a
     * surrogate PAIR: two three-byte sequences that are each invalid UTF-8 on
     * their own. `JavaStr` derefs to `CStr`, whose `to_string_lossy()` decodes
     * byte by byte and would turn each half into U+FFFD ("猫" survives, "𠮷"
     * becomes two replacement characters, and the search page would look up
     * garbage). `From<JavaStr> for String` goes through
     * `cesu8::from_java_cesu8`, which pairs them back into the one scalar the
     * clipboard actually held.
     */
    let decoded = env.get_string(&text)?;
    Ok(Some(decoded.into()))
}

#[cfg(test)]
mod tests {
    use super::non_empty;

    #[test]
    fn blank_clipboard_reads_as_nothing() {
        // An empty clipboard is the common case (a copy that was cut away), and
        // it must not reach the search field as an empty query.
        expect_none(None);
        expect_none(Some(String::new()));
    }

    #[test]
    fn text_is_passed_through_verbatim() {
        // NOT trimmed: trailing whitespace is the caller's decision
        // (`normalizeSearchQuery`), and a clipboard that differs from the last
        // sample only in spacing is not a new search.
        expect_some("  落ちる \n");
        expect_some("猫");
    }

    fn expect_none(value: Option<String>) {
        assert_eq!(non_empty(value), None);
    }

    fn expect_some(value: &str) {
        assert_eq!(non_empty(Some(value.to_string())), Some(value.to_string()));
    }
}
