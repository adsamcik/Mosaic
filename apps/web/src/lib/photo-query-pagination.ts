import type { DbWorkerApi, PhotoMeta } from '../workers/types';

export const PHOTO_QUERY_PAGE_SIZE = 1000;

type PhotoPageFetcher = (
  limit: number,
  offset: number,
) => Promise<PhotoMeta[]>;

async function loadAllPhotoPages(
  fetchPage: PhotoPageFetcher,
  pageSize: number,
): Promise<PhotoMeta[]> {
  const photos: PhotoMeta[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(pageSize, offset);
    photos.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return photos;
}

export async function loadAllAlbumPhotos(
  db: Pick<DbWorkerApi, 'getPhotos'>,
  albumId: string,
  pageSize = PHOTO_QUERY_PAGE_SIZE,
): Promise<PhotoMeta[]> {
  return loadAllPhotoPages(
    (limit, offset) => db.getPhotos(albumId, limit, offset),
    pageSize,
  );
}

export async function searchAllAlbumPhotos(
  db: Pick<DbWorkerApi, 'searchPhotos'>,
  albumId: string,
  query: string,
  pageSize = PHOTO_QUERY_PAGE_SIZE,
): Promise<PhotoMeta[]> {
  return loadAllPhotoPages(
    (limit, offset) => db.searchPhotos(albumId, query, limit, offset),
    pageSize,
  );
}
