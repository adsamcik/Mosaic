//! Cross-platform protocol contract: canonical tier dimensions are pinned at
//! 256/1024/4096. Any change here is a v1 break and must be approved.

use mosaic_media::{ORIGINAL_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION};

#[test]
fn thumbnail_max_dimension_is_frozen_at_256() {
    assert_eq!(
        THUMBNAIL_MAX_DIMENSION, 256,
        "Cross-platform protocol contract: thumbnail = 256px. Changing this requires v2 break + Android/iOS/web migration plan."
    );
}

#[test]
fn preview_max_dimension_is_frozen_at_1024() {
    assert_eq!(
        PREVIEW_MAX_DIMENSION, 1024,
        "Cross-platform protocol contract: preview = 1024px. Changing this requires v2 break + Android/iOS/web migration plan."
    );
}

#[test]
fn original_max_dimension_is_frozen_at_4096() {
    assert_eq!(
        ORIGINAL_MAX_DIMENSION, 4096,
        "Cross-platform protocol contract: original = 4096px. Changing this requires v2 break + Android/iOS/web migration plan."
    );
}
