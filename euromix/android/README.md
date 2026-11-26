# Euromix Android

Android client source for the Euromix single live radio stream.

## Build
Use Android Gradle Plugin 8.7.3, Kotlin 2.0.21, JDK 17, Android SDK 35.
Run `gradle :app:assembleDebug` from this directory.

## Current status
This is a buildable client preview. The radio stream URL, backend API URL, and NettleGroup Verify callback are deliberately not fabricated. They remain blank until the production radio server and secure Verify bridge are deployed. The app therefore installs, but live playback and admin operations are not active yet.
