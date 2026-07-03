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
        versionCode = 27
        versionName = "0.27.0-v37-account-switch"
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
}
