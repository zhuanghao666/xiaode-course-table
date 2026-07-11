plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xiaode.importhelper"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.xiaode.importhelper"
        minSdk = 23
        targetSdk = 35
        versionCode = 29
        versionName = "0.29.0-v40-import-diagnostics"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}


dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    testImplementation("junit:junit:4.13.2")
}
