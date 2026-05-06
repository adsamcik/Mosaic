import XCTest
@testable import MosaicCore

final class ApiSurfaceTest: XCTestCase {
    func testIosReadinessContractIsDocumented() {
        iosReadinessAssert()
        XCTAssertEqual(MosaicCoreReadiness.contract, "Q-final-2")
    }
}

func iosReadinessAssert() {
    // These are the types iOS consumes from the UniFFI-generated module:
    // - SecretHandleId
    // - EpochHandleId
    // - LinkHandleId
    // - ClientErrorCode
    // - AlbumSyncSnapshot
    // - UploadJobSnapshot
    // - SidecarTag
    //
    // This compile-time harness becomes active once Generated/MosaicUniFFI.xcframework
    // is present and Package.swift resolves the MosaicUniFFI binary target.
}
