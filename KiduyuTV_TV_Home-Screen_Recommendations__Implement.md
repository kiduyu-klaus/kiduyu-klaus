# KiduyuTV TV Home-Screen Recommendations: Implementation Guide

## Scope and launcher differences

Android TV home-screen recommendations are not a row that KiduyuTV draws inside its own Compose UI. The app publishes metadata to the system TV provider, and the device's home launcher decides where and how the channel is shown. On Android 8.0 (API 26) and later, the modern Android TV model is a channel containing preview programs. On Android 7.1 (API 25) and earlier, the compatibility model is a notifications-based recommendations row. Google recommends implementing both APIs when supporting both version ranges. The project declares `minSdk 24`, so API 24–25 devices are in its install range unless support is narrowed. [1] [2] [3]

Fire TV needs a separate adapter. Amazon describes its “Recommended By Your Apps” (ReYA) row as based on Android recommendation notifications, with behavior differing across Fire OS generations. Fire OS 5/6 use the older recommendation row, while Fire OS 7 is Android 9/API 28 and drops notifications without a notification-channel ID. This notification channel is not the same thing as an Android TV `TvProvider` preview channel. Do not assume the Android TV provider channel appears in Fire TV ReYA. The Amazon overview is from 2021; validate the current ReYA behavior on the Fire OS versions you target. [4] [5]

The app’s TV flavor is `com.kiduyuk.klausk.kiduyutv.tv`. `MainActivity` is currently `exported="false"`; it already routes intents carrying `NOTIFICATION_MEDIA_ID` and `NOTIFICATION_MEDIA_TYPE` to the movie or TV detail route, but it does not declare itself as an external deep-link target. A safe design is to add a small exported recommendation-entry activity that accepts only validated app-specific URIs, then starts the internal `MainActivity` with those existing extras. Do not expose the whole navigation activity just to make home-screen cards launch. [11] [12]

## What KiduyuTV should publish

For the default Android TV channel, use a useful, stable title such as “Trending on KiduyuTV” and populate it from the existing cached trending movie and TV-show endpoints. `TmdbRepository` already exposes `getTrendingMoviesToday()` and `getTrendingTvToday()`. `Movie` and `TvShow` provide IDs, title/name, overview, poster path, backdrop path, rating, and release/air date; `TmdbApiService` defines `IMAGE_BASE_URL`, `POSTER_SIZE` (`w500`) and `BACKDROP_SIZE`. Treat these as catalogue discovery cards: the app’s existing detail screens are the destination. Do not claim availability, pricing, or direct playback unless the app actually has that entitlement/route for the item. [11] [13] [14]

A good initial release can use one default channel mixing movies and series, so the app contributes a useful row without asking users to configure several rows. If you later add separate “Movies” and “TV Shows” channels, they are additional channels and the user must approve them before they become browsable. The home launcher controls ordering and can let users hide or reorder channels. A “Continue watching” or next-episode item belongs in the system-managed Watch Next channel only when it reflects genuine user engagement or continuation; do not fill Watch Next with general trending titles. [1] [6]

## Add the AndroidX TV Provider dependency and permission

The repository currently has no declared `androidx.tvprovider` dependency or TV-provider permission. Add the dependency in `app/build.gradle` for the TV integration:

```groovy
dependencies {
    implementation("androidx.tvprovider:tvprovider:1.0.0")
}
```

Google’s guide documents this artifact and requires `com.android.providers.tv.permission.WRITE_EPG_DATA` for provider access. Put the permission in a TV-specific manifest if the phone flavor should not declare TV-only capabilities. Feature-detect Leanback and catch provider/security failures: not every device launcher exposes the same provider behavior, and one OEM’s support is not proof for another. [2] [9]

```xml
<!-- app/src/tv/AndroidManifest.xml; merge with the existing TV flavor manifest -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="com.android.providers.tv.permission.WRITE_EPG_DATA" />
</manifest>
```

The Android TV provider permission and API are for Android TV launchers. For Fire TV ReYA, use the notification path described below instead of treating the provider as a cross-launcher contract.

## Create one stable default channel

Create the channel idempotently, persist its provider ID, and keep the channel creation code off the main thread. Android’s first channel is the app’s default channel and can appear without a separate approval dialog. Later channels need an explicit user request through `ACTION_REQUEST_CHANNEL_BROWSABLE`. The first channel should have a display name, `TYPE_PREVIEW`, an app-link URI, and an opaque channel logo. Google documents the channel logo as 80dp × 80dp. [1] [2]

```kotlin
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import androidx.tvprovider.media.tv.Channel
import androidx.tvprovider.media.tv.ChannelLogoUtils
import androidx.tvprovider.media.tv.TvContractCompat

private const val PREFS = "tv_recommendations"
private const val KEY_DEFAULT_CHANNEL_ID = "default_channel_id"
private const val DEFAULT_CHANNEL_NAME = "Trending on KiduyuTV"

fun ensureDefaultChannel(context: Context, opaqueLogo: android.graphics.Bitmap): Long {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs.getLong(KEY_DEFAULT_CHANNEL_ID, -1L).takeIf { it > 0L }?.let { return it }

    val values = Channel.Builder()
        .setType(TvContractCompat.Channels.TYPE_PREVIEW)
        .setDisplayName(DEFAULT_CHANNEL_NAME)
        .setAppLinkIntentUri(Uri.parse("kiduyutv://home"))
        .build()
        .toContentValues()

    val channelUri = requireNotNull(
        context.contentResolver.insert(TvContractCompat.Channels.CONTENT_URI, values)
    ) { "TV provider did not insert the recommendation channel" }
    val channelId = ContentUris.parseId(channelUri)

    ChannelLogoUtils.storeChannelLogo(context, channelId, opaqueLogo)
    prefs.edit().putLong(KEY_DEFAULT_CHANNEL_ID, channelId).apply()
    return channelId
}
```

Treat the saved ID as a cache, not absolute truth: app data can be cleared or provider state can be reset. On startup, verify the channel still exists before using it; if the provider rejects the operation, log the failure and keep the in-app browsing experience intact. Do not create multiple default channels on every launch. The platform sends `android.media.tv.action.INITIALIZE_PROGRAMS` on supported Leanback devices; an exported receiver can enqueue a short, idempotent initialization job. Do not perform network calls or a large image sync inside `BroadcastReceiver.onReceive()`. Google advises using scheduled work for background updates and handling rare duplicate initialization broadcasts. [2] [9]

```xml
<receiver
    android:name=".recommendations.InitializeRecommendationsReceiver"
    android:exported="true">
    <intent-filter>
        <action android:name="android.media.tv.action.INITIALIZE_PROGRAMS" />
        <category android:name="android.intent.category.DEFAULT" />
    </intent-filter>
</receiver>
```

For an unauthenticated first install, seed the default channel with public trending titles or cached catalogue data. After login, refresh it with a relevant set. When an app user explicitly selects another channel in settings, create that channel once and launch `TvContractCompat.ACTION_REQUEST_CHANNEL_BROWSABLE` with `EXTRA_CHANNEL_ID`; handle cancellation and do not imply that the channel was added if the user declines. [2]

## Publish movie and TV-show cards

For each movie, use `TYPE_MOVIE`; for each show, use `TYPE_TV_SERIES`. Provide a channel ID, title, appropriate poster-art aspect ratio and URI, and a click intent URI. Store a stable app-owned key such as `movie:123` or `tv:456` in `internalProviderId`; it lets the app reconcile provider rows with its catalogue. Use movie-poster aspect ratio for posters. The video-program guide lists poster-aspect choices and recommended preview image dimensions. Avoid sending blank titles or empty poster paths. [3] [10]

The code below demonstrates the provider insert shape. Resolve the exact image URL using the project’s TMDB constants and validate that the response is available. If images are cached, use a URI that the home provider can continue to load. Image URIs are cached by the TV home implementation; change the URI when the underlying image changes, or an old cached poster may remain visible. [2] [10] [13]

```kotlin
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import androidx.tvprovider.media.tv.PreviewProgram
import androidx.tvprovider.media.tv.TvContractCompat

private fun recommendationIntentUri(kind: String, tmdbId: Int): Uri {
    require(kind == "movie" || kind == "tv")
    require(tmdbId > 0)
    return Uri.parse("kiduyutv://$kind/$tmdbId")
}

fun insertMovieProgram(
    context: Context,
    channelId: Long,
    movieId: Int,
    title: String,
    overview: String?,
    posterArtUri: Uri
): Long {
    val values = PreviewProgram.Builder()
        .setChannelId(channelId)
        .setType(TvContractCompat.PreviewPrograms.TYPE_MOVIE)
        .setTitle(title)
        .setDescription(overview.orEmpty())
        .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_MOVIE_POSTER)
        .setPosterArtUri(posterArtUri)
        .setIntentUri(recommendationIntentUri("movie", movieId))
        .setInternalProviderId("movie:$movieId")
        .build()
        .toContentValues()

    val programUri = requireNotNull(
        context.contentResolver.insert(TvContractCompat.PreviewPrograms.CONTENT_URI, values)
    ) { "TV provider did not insert the movie recommendation" }
    return ContentUris.parseId(programUri)
}
```

Implement the show version with `TvContractCompat.PreviewPrograms.TYPE_TV_SERIES`, `tv:<id>` and `kiduyutv://tv/<id>`. The `Movie` model uses `title`; `TvShow` uses `name`. Make the `intent_uri` a real route to a detail page, not a placeholder. [3] [13] [14]

## Deep-link a home-screen card into the existing app

Add a small exported `RecommendationEntryActivity` with `ACTION_VIEW`, `DEFAULT`, and `BROWSABLE` intent filters for the `kiduyutv://home`, `kiduyutv://movie/<id>`, and `kiduyutv://tv/<id>` URIs. Validate host, path, positive integer ID, and allowed media type before forwarding. Then explicitly start the existing non-exported `MainActivity` with the keys it already understands: `NOTIFICATION_MEDIA_ID` and `NOTIFICATION_MEDIA_TYPE`. The `home` URI starts MainActivity without a media extra. Because the current handler runs during initial Compose setup and the Activity has no `onNewIntent()` override, either ensure the trampoline starts a fresh MainActivity task or add robust new-intent handling that queues routing until the NavHost is ready. Do not set `MainActivity` to exported just for these cards. [11] [12]

```xml
<!-- Add to the existing app/src/tv/AndroidManifest.xml application block. -->
<activity
    android:name=".recommendations.RecommendationEntryActivity"
    android:exported="true"
    android:noHistory="true">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="kiduyutv" android:host="home" />
    </intent-filter>
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="kiduyutv" android:host="movie" android:pathPrefix="/" />
    </intent-filter>
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="kiduyutv" android:host="tv" android:pathPrefix="/" />
    </intent-filter>
</activity>
```

The entry activity should never trust an arbitrary external URI. Its routing logic should be small and strict:

```kotlin
val uri = intent?.data
val type = when (uri?.host) {
    "movie" -> "movie"
    "tv" -> "tv"
    else -> null
}
val id = uri?.lastPathSegment?.toIntOrNull()

if (uri?.host == "home") {
    startActivity(Intent(this, MainActivity::class.java).addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
    ))
    finish()
    return
}
if (type == null || id == null || id <= 0) {
    finish()
    return
}

startActivity(Intent(this, MainActivity::class.java).apply {
    putExtra("NOTIFICATION_MEDIA_ID", id)
    putExtra("NOTIFICATION_MEDIA_TYPE", type)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
})
finish()
```

Adapt task/back-stack flags after device testing. The existing MainActivity routes movie IDs to `Screen.MovieDetail` and TV IDs to `Screen.TvShowDetail`; these routes match the requested use case. The clear-task example intentionally ensures `onCreate()` receives the extras, but product UX may prefer preserving an existing task and implementing `onNewIntent()` instead. [11] [12]

## Reconcile updates without duplicates or resurrecting removed cards

The provider is a second index of selected recommendation data, not the source of truth. Keep TMDB/app data authoritative. Persist the channel ID and use `internalProviderId` as the stable key. When refreshing, query programs for that channel, map existing rows by `internalProviderId`, then insert missing items, update changed items by their item URI, and remove stale app-owned rows. Google warns not to use SQL-style `WHERE` clauses with these provider calls. Respect a program the user dismissed: the system sends `ACTION_PREVIEW_PROGRAM_BROWSABLE_DISABLED`; delete that row locally and do not recreate it on the next refresh. Catch `SecurityException` and `ActivityNotFoundException`. [2] [9]

Run reconciliation after a successful catalogue refresh or app launch, not in a tight loop. Limit the channel to a small curated set, use stable ordering/weights, avoid re-posting unchanged rows, and do not delete/reinsert everything because that can push cards to the end. Treat exact launcher ranking and display as system-owned behavior. [1] [2] [7]

Use durable, system-readable poster URIs and a stable local cache. `PreviewProgram` artwork columns accept URLs and certain content/resource/file URI schemes. Do not persist a short-lived signed URL. If an artwork changes, version the URI. A practical app design is to download posters using the existing image/network stack to an app-controlled cache, expose them through a narrowly scoped read-only content provider, and store those URIs; test whether every target launcher can read them. [10]

## Optional: publish real continuation items to Watch Next

Watch Next is created and ordered by the system. Add only user-related content: a movie stopped before completion, an episode the user has actually begun, the next available episode, or content explicitly saved by the user. For example, the provider model has `WATCH_NEXT_TYPE_CONTINUE` and a last-engagement timestamp. Keep completion/removal state synchronized; never turn a public “Trending” list into a fake Continue Watching row. The current project has movie/show detail routes, but this guide did not confirm a durable watched-position source for every catalogue item, so verify that data model before enabling this feature. [6] [15]

```kotlin
val values = WatchNextProgram.Builder()
    .setType(TvContractCompat.WatchNextPrograms.TYPE_MOVIE)
    .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
    .setLastEngagementTimeUtcMillis(lastEngagementMillis)
    .setTitle(title)
    .setDescription(description)
    .setPosterArtUri(posterUri)
    .setIntentUri(Uri.parse("kiduyutv://movie/$tmdbId"))
    .setInternalProviderId("movie:$tmdbId")
    .build()
    .toContentValues()

context.contentResolver.insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, values)
```

When a preview program is copied to Watch Next, Android sends `ACTION_PREVIEW_PROGRAM_ADDED_TO_WATCH_NEXT` with both source and Watch Next IDs. Handle that event if the app needs to track the copy or keep the two provider rows consistent. [6] [9]

## Legacy Android TV recommendation row for API 24–25

If API 24–25 Android TV devices remain in the support matrix, implement the legacy row with recommendation notifications on those API levels. The current docs limit this path to Android 7.1/API 25 and earlier. The recommendation is a notification with category `CATEGORY_RECOMMENDATION`, title/description, an image, local-only behavior and a unique `PendingIntent`. Use a stable notification ID per item and cancel/update notifications instead of posting duplicates. [1] [7]

```kotlin
fun postLegacyRecommendation(
    context: Context,
    id: Int,
    title: String,
    description: String,
    poster: Bitmap,
    clickIntent: PendingIntent
) {
    val notification = Notification.Builder(context)
        .setSmallIcon(R.drawable.ic_notification)
        .setLargeIcon(poster)
        .setContentTitle(title)
        .setContentText(description)
        .setCategory(Notification.CATEGORY_RECOMMENDATION)
        .setLocalOnly(true)
        .setOngoing(true)
        .setContentIntent(clickIntent)
        .build()
    context.getSystemService(NotificationManager::class.java).notify(id, notification)
}
```

The Android legacy row documentation uses background processing and a notification builder. For Android TV API 26+ do not mistake generic notification channels for preview-program channels; use `TvProvider` for the Android TV home content channel. If you also target Fire TV ReYA, implement and validate its notification requirements separately. [1] [5] [7]

## Fire TV “Recommended By Your Apps” (ReYA) adapter

The Amazon overview says ReYA includes recommendations from apps that have been installed and opened at least once. For Fire OS 5/6 Amazon describes the older notification recommendations row. For Fire OS 7/API 28 and later, every notification must have a notification-channel ID or it is dropped. Amazon documents a recommendation-category notification with recommendation metadata, artwork and a content intent. [4] [5]

This is a different use of “channel”: a Fire OS notification channel is a notification settings/category object. Create it before posting, then use `Notification.Builder(context, CHANNEL_ID)` on API 26+ while keeping the recommendation category and the fields required by the Amazon recommendation contract. Do not use reflection to mutate the notification’s private `mChannelId`; use the builder that accepts the channel ID. On API 24–25, use the legacy no-channel builder. The project’s `minSdk 24` excludes Fire OS 5/API 22 but includes Fire OS 6/API 25. Test Fire OS 6 and current target Fire OS versions on actual devices; ReYA visibility is launcher-owned and not guaranteed by a successful `notify()` call. [4] [5] [8]

```kotlin
private const val FIRE_RECOMMENDATION_CHANNEL = "kiduyutv_recommendations"

fun ensureFireNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                FIRE_RECOMMENDATION_CHANNEL,
                "KiduyuTV recommendations",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Movie and TV-show picks from KiduyuTV"
            }
        )
    }
}

fun buildFireRecommendation(
    context: Context,
    apiLevel: Int,
    title: String,
    description: String,
    sourceName: String,
    poster: Bitmap,
    backgroundImageUrl: String,
    click: PendingIntent
): Notification {
    val builder = if (apiLevel >= Build.VERSION_CODES.O) {
        Notification.Builder(context, FIRE_RECOMMENDATION_CHANNEL)
    } else {
        Notification.Builder(context)
    }

    return builder
        .setSmallIcon(R.drawable.ic_notification)
        .setLargeIcon(poster)
        .setContentTitle(title)
        .setContentText(description)
        .setContentInfo(sourceName)
        .setCategory(Notification.CATEGORY_RECOMMENDATION)
        .setLocalOnly(true)
        .setOngoing(true)
        .setContentIntent(click)
        .apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                extras.putString(Notification.EXTRA_BACKGROUND_IMAGE_URI, backgroundImageUrl)
            }
        }
        .build()
}
```

Treat this as a construction sketch, not a complete Amazon-certified `RecommendationExtender`. Amazon’s Fire OS 7 page shows additional recommendation metadata (such as content type, genres, pricing, maturity rating and running time) through its extender example. Map those fields only when KiduyuTV has verified values, and consult the latest Amazon Fire TV recommendation/sample material for the current ReYA contract. The API guide cited here is specific to Fire OS 7, and Amazon’s overview is older; do not infer uniform behavior for every Fire OS 8/14/16 launcher. [4] [5]

## Implementation order for this repository

1. Decide whether the deliverable is Android TV/Google TV, Amazon Fire TV, or both. Use separate publisher adapters: Android `TvProvider` channels for Android TV API 26+, legacy recommendation notifications for Android TV API 24–25, and Fire TV ReYA notifications only for confirmed Fire OS targets.
2. Add `androidx.tvprovider:tvprovider:1.0.0` and the provider permission to the TV flavor. Add a recommendation module with stable channel/program keys, provider-ID persistence, poster caching and bounded reconciliation.
3. Add a default `Trending on KiduyuTV` channel and populate it with a short, useful mix from the existing TMDB repository. Avoid starting network work in a receiver.
4. Add an exported, URI-validating trampoline for `kiduyutv://home`, `kiduyutv://movie/<id>` and `kiduyutv://tv/<id>`. Forward to the existing internal `MainActivity` using its current notification extras and detail routes; handle card clicks when the app is cold and already running.
5. Add an in-app “Add recommendation channel” control for any extra channels. Let the system show its approval flow. Respect user removal and channel-hidden state; do not recreate dismissed programs.
6. Add Watch Next only after connecting it to reliable watch-progress/next-episode data. Keep it semantically separate from generic recommendations.
7. If Fire TV is in scope, add the ReYA notification strategy behind device/API-aware code and test it independently from Android TV provider channels. Current docs do not establish that Fire TV ReYA behaves identically across all current models.
8. Add instrumentation/manual tests, then run build and device testing. The app currently has no TV-provider dependency/permission, `MainActivity` is non-exported, and no recommendation publishing implementation was found. No source edits or Gradle build were performed for this guide. [11] [12] [13]

## Validation checklist

- On Android TV API 26+, confirm the first default channel appears after install/initialization, and extra channels only appear after user approval.
- On Android TV API 24–25, verify the legacy recommendation row with the API-appropriate notification path; also decide whether these lower APIs are truly supported, given the TV navigation graph is annotated `@RequiresApi(O)`.
- Verify each card’s poster, title, show/movie type, click-through detail page, Back behavior, and cold-start/resume behavior.
- Confirm channel initialization is idempotent, program refresh never floods the provider, and dismissed items stay removed.
- Test absent/disabled TV provider, no network, expired image URLs, unreadable artwork URI, background/duplicate install broadcasts and `SecurityException` handling.
- On Fire TV, test ReYA separately on each target Fire OS family. Confirm the app has been opened once, recommendation notifications carry a notification channel on API 26+, and clicking a card enters the intended detail page.
- Check that the Android TV home launcher or Fire TV ReYA actually displays the row. Apps can publish data, but the system, launcher and user control final visibility and order.

## Project source locations (reviewed)

These links point to the repository state reviewed for this guide. The current main branch may advance after this document is written.

- [Gradle configuration and flavors](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/build.gradle)
- [Android manifest](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/AndroidManifest.xml)
- [MainActivity notification extras and navigation](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/activity/mainactivity/MainActivity.kt)
- [TV route definitions](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/ui/navigation/Screen.kt)
- [TV NavGraph detail destinations](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/ui/navigation/NavGraph.kt)
- [Movie and TV-show data models](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/data/model/Models.kt)
- [TMDB API and image URL configuration](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/data/api/TmdbApiService.kt)
- [TMDB repository cached trending calls](https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/data/repository/TmdbRepository.kt)

## References

[1]: https://developer.android.com/training/tv/discovery/recommendations "Recommend content on the home screen"
[2]: https://developer.android.com/training/tv/discovery/recommendations-channel "Channels on the home screen"
[3]: https://developer.android.com/training/tv/discovery/recommendations-row "Recommendations row for Android N and earlier"
[4]: https://developer.amazon.com/apps-and-games/blogs/2021/07/tutorial-recommendations-on-fire-tv "Tutorial: Recommendations on Fire TV"
[5]: https://developer.amazon.com/docs/fire-tv/fire-os-7.html "Developing for Amazon Fire TV Devices Running Fire OS 7"
[6]: https://developer.android.com/training/tv/discovery/watch-next-add-programs "Add programs to the Watch Next channel"
[7]: https://developer.android.com/training/tv/discovery/video-programs "Add video programs to a channel"
[8]: https://developer.android.com/develop/ui/views/notifications/channels "Create and manage notification channels"
[9]: https://developer.android.com/reference/androidx/tvprovider/media/tv/TvContractCompat "TvContractCompat reference"
[10]: https://developer.android.com/reference/androidx/tvprovider/media/tv/TvContractCompat.PreviewProgramColumns "PreviewProgramColumns reference"
[11]: https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/activity/mainactivity/MainActivity.kt "KiduyuTV MainActivity at reviewed commit"
[12]: https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/AndroidManifest.xml "KiduyuTV manifest at reviewed commit"
[13]: https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/data/repository/TmdbRepository.kt "KiduyuTV TMDB repository at reviewed commit"
[14]: https://github.com/kiduyu-klaus/KiduyuTv_final/blob/74c25b1/app/src/main/java/com/kiduyuk/klausk/kiduyutv/data/model/Models.kt "KiduyuTV media models at reviewed commit"
[15]: https://developer.android.com/reference/androidx/tvprovider/media/tv/WatchNextProgram.Builder "WatchNextProgram.Builder reference"
