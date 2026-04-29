// Mosaic Gradle root settings — owns the single Android Gradle module today
// (`apps/android-main`). Other apps (backend, web, admin) use their own toolchains
// (.NET, npm/Vite) and are not part of this Gradle build.
//
// Android Studio sees this file when opening the repository root.

@Suppress("UnstableApiUsage")
pluginManagement {
  repositories {
    google {
      content {
        includeGroupByRegex("com\\.android.*")
        includeGroupByRegex("com\\.google.*")
        includeGroupByRegex("androidx.*")
      }
    }
    mavenCentral()
    gradlePluginPortal()
  }
}

@Suppress("UnstableApiUsage")
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "mosaic"

include(":apps:android-main")
project(":apps:android-main").projectDir = file("apps/android-main")
