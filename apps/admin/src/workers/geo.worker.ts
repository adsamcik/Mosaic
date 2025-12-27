/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import Supercluster from 'supercluster';
import type { GeoWorkerApi, GeoFeature } from './types';

/**
 * Geo Worker Implementation
 * Uses Supercluster for efficient map point clustering
 */
class GeoWorker implements GeoWorkerApi {
  private cluster: Supercluster<GeoFeature['properties']> | null = null;

  load(points: GeoFeature[]): void {
    // Create new Supercluster instance with clustering options
    this.cluster = new Supercluster<GeoFeature['properties']>({
      radius: 60,      // Cluster radius in pixels
      maxZoom: 16,     // Max zoom to cluster at
      minZoom: 0,      // Min zoom level
      minPoints: 2,    // Minimum points to form a cluster
    });

    // Load points into the clusterer
    this.cluster.load(points as GeoJSON.Feature<GeoJSON.Point, GeoFeature['properties']>[]);
  }

  getClusters(
    bbox: [number, number, number, number],
    zoom: number
  ): GeoFeature[] {
    if (!this.cluster) {
      return [];
    }

    const clusters = this.cluster.getClusters(bbox, Math.floor(zoom));
    return clusters as unknown as GeoFeature[];
  }

  getLeaves(clusterId: number, limit: number, offset: number): GeoFeature[] {
    if (!this.cluster) {
      return [];
    }

    const leaves = this.cluster.getLeaves(clusterId, limit, offset);
    return leaves as unknown as GeoFeature[];
  }
}

// Create worker instance and expose via Comlink
const worker = new GeoWorker();
Comlink.expose(worker);
