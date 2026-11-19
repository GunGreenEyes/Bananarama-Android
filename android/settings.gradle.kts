pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "Bananarama"

// core = plain Kotlin/JVM (Gemini client, stream parsing, local API); builds without the Android SDK.
include(":core")
// app = the Android app; skipped with BANANARAMA_CORE_ONLY=1 on machines without the SDK.
if (System.getenv("BANANARAMA_CORE_ONLY") == null) include(":app")
