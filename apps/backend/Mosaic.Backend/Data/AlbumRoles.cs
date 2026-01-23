namespace Mosaic.Backend.Data;

/// <summary>
/// Constants for album member roles.
/// Roles are stored as lowercase strings in the database for simplicity and cross-platform compatibility.
/// </summary>
public static class AlbumRoles
{
    /// <summary>
    /// Album owner - can upload, delete, manage members, and delete the album.
    /// </summary>
    public const string Owner = "owner";

    /// <summary>
    /// Album editor - can upload and delete photos.
    /// </summary>
    public const string Editor = "editor";

    /// <summary>
    /// Album viewer - can only view photos.
    /// </summary>
    public const string Viewer = "viewer";

    /// <summary>
    /// Checks if the role can upload photos.
    /// </summary>
    public static bool CanUpload(string role) => role == Owner || role == Editor;

    /// <summary>
    /// Checks if the role can manage album members.
    /// </summary>
    public static bool CanManageMembers(string role) => role == Owner;

    /// <summary>
    /// Checks if the role is valid (owner, editor, or viewer).
    /// </summary>
    public static bool IsValid(string role) => role == Owner || role == Editor || role == Viewer;

    /// <summary>
    /// Checks if the role is valid for invitation (only editor and viewer can be invited).
    /// </summary>
    public static bool IsValidForInvite(string role) => role == Editor || role == Viewer;
}
