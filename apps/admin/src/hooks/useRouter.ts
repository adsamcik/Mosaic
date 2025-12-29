import { useCallback, useEffect, useState } from 'react';

/**
 * Route definitions for the application
 * - / -> Albums list (home)
 * - /albums -> Albums list (alias)
 * - /albums/:albumId -> Gallery view
 * - /settings -> Settings page
 * - /admin -> Admin panel
 * - /s/:linkId -> Share link (handled separately in App.tsx)
 */
export type Route =
  | { view: 'albums'; albumId?: never }
  | { view: 'gallery'; albumId: string }
  | { view: 'settings'; albumId?: never }
  | { view: 'admin'; albumId?: never };

/**
 * Parse the current URL pathname into a Route
 */
function parseRoute(): Route {
  const pathname = window.location.pathname;

  // Gallery: /albums/:albumId
  const albumMatch = pathname.match(/^\/albums\/([a-f0-9-]+)$/i);
  if (albumMatch && albumMatch[1]) {
    return { view: 'gallery', albumId: albumMatch[1] };
  }

  // Settings
  if (pathname === '/settings') {
    return { view: 'settings' };
  }

  // Admin
  if (pathname === '/admin') {
    return { view: 'admin' };
  }

  // Default to albums (handles /, /albums, and unknown paths)
  return { view: 'albums' };
}

/**
 * Build a URL path for a given route
 */
function buildPath(route: Route): string {
  switch (route.view) {
    case 'gallery':
      return `/albums/${route.albumId}`;
    case 'settings':
      return '/settings';
    case 'admin':
      return '/admin';
    case 'albums':
    default:
      return '/';
  }
}

/**
 * Custom hook for URL-based routing
 * Updates the URL as users navigate and handles browser back/forward
 */
export function useRouter() {
  const [route, setRoute] = useState<Route>(parseRoute);

  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  /**
   * Navigate to a new route, updating both state and URL
   */
  const navigate = useCallback((newRoute: Route) => {
    const path = buildPath(newRoute);
    const currentPath = window.location.pathname;

    // Only push state if path is different
    if (path !== currentPath) {
      window.history.pushState(null, '', path);
    }

    setRoute(newRoute);
  }, []);

  /**
   * Navigate to albums list
   */
  const navigateToAlbums = useCallback(() => {
    navigate({ view: 'albums' });
  }, [navigate]);

  /**
   * Navigate to a specific album's gallery
   */
  const navigateToGallery = useCallback((albumId: string) => {
    navigate({ view: 'gallery', albumId });
  }, [navigate]);

  /**
   * Navigate to settings
   */
  const navigateToSettings = useCallback(() => {
    navigate({ view: 'settings' });
  }, [navigate]);

  /**
   * Navigate to admin panel
   */
  const navigateToAdmin = useCallback(() => {
    navigate({ view: 'admin' });
  }, [navigate]);

  /**
   * Go back in history, with a fallback route
   */
  const goBack = useCallback((fallback: Route = { view: 'albums' }) => {
    // Check if we can go back
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate(fallback);
    }
  }, [navigate]);

  return {
    route,
    navigate,
    navigateToAlbums,
    navigateToGallery,
    navigateToSettings,
    navigateToAdmin,
    goBack,
  };
}
