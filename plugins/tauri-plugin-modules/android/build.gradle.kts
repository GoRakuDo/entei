plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.gorakudo.entei.modules.ankidroid"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }
}

repositories {
    google()
    mavenCentral()
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.google.android.material:material:1.7.0")
    implementation("androidx.core:core-ktx:1.12.0")
    // AnkiDroid API (official JitPack coordinate). This is the library that owns
    // FlashCardsContract + AddContentApi, so the module never hand-rolls the
    // ContentProvider URIs or the provider-spec handshake.
    implementation("com.github.ankidroid:Anki-Android:api-v1.1.0")
}
