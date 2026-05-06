#if canImport(MosaicUniFFI)
@_exported import MosaicUniFFI
#endif

/// Stable Swift package facade for Mosaic's UniFFI-generated iOS bindings.
///
/// The generated `MosaicUniFFI` module is produced from `crates/mosaic-uniffi`
/// and supplied as `Generated/MosaicUniFFI.xcframework`. This facade keeps iOS
/// application code importing `MosaicCore` while the generated binding artifact
/// remains replaceable during regeneration.
public enum MosaicCoreReadiness {
    /// Readiness contract identifier for the Q-final-2 iOS adapter scaffold.
    public static let contract = "Q-final-2"
}
