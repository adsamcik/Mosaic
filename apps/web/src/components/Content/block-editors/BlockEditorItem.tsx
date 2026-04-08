/**
 * BlockEditorItem Component
 *
 * Renders the appropriate editor for a given content block type.
 * Wraps each block in a SortableBlock for drag-and-drop support.
 */

import { memo, useCallback } from 'react';
import { TextEditor } from './TextEditor';
import { HeadingEditor } from './HeadingEditor';
import { PhotoGridEditor } from './PhotoGridEditor';
import { SortableBlock } from './SortableBlock';
import type { BlockEditorItemProps } from './types';

export const BlockEditorItem = memo(function BlockEditorItem({
  block,
  onUpdate,
  onDelete,
  getThumbnailUrl,
  onSlashCommand,
  onSlashQueryChange,
  onSlashCancel,
  onAddPhotos,
}: BlockEditorItemProps) {
  const handleSlashCommand = useCallback(
    (rect: DOMRect) => {
      onSlashCommand?.(block.id, rect);
    },
    [block.id, onSlashCommand],
  );

  const renderBlockEditor = () => {
    switch (block.type) {
      case 'heading':
        return (
          <HeadingEditor
            text={block.text}
            level={block.level}
            onChange={(text, level) => onUpdate({ text, level })}
          />
        );

      case 'text':
        return (
          <TextEditor
            content={block.segments}
            onChange={(segments) => onUpdate({ segments })}
            onSlashCommand={handleSlashCommand}
            onSlashQueryChange={onSlashQueryChange}
            onSlashCancel={onSlashCancel}
          />
        );

      case 'photo': {
        const url = getThumbnailUrl?.(block.manifestId);
        return (
          <div className="photo-block-editor">
            {url ? (
              <img src={url} alt="" className="photo-block-preview" />
            ) : (
              <div className="photo-block-placeholder">
                Photo: {block.manifestId.slice(0, 8)}...
              </div>
            )}
            <div className="photo-caption-editor">
              <TextEditor
                content={block.caption ?? [{ text: '' }]}
                onChange={(segments) => {
                  // Only store caption if non-empty
                  const hasContent = segments.some((s) => s.text.trim().length > 0);
                  onUpdate({ caption: hasContent ? segments : undefined });
                }}
                placeholder="Add a caption..."
              />
            </div>
          </div>
        );
      }

      case 'photo-group': {
        const handleAddPhotosClick = () => {
          onAddPhotos?.(block.id);
        };
        return (
          <PhotoGridEditor
            manifestIds={block.manifestIds}
            layout={block.layout}
            onUpdate={onUpdate}
            getThumbnailUrl={getThumbnailUrl}
            onAddPhotos={handleAddPhotosClick}
          />
        );
      }

      case 'divider':
        return (
          <div className="divider-editor">
            <select
              value={block.style}
              onChange={(e) =>
                onUpdate({ style: e.target.value as 'line' | 'dots' | 'space' })
              }
              className="divider-style-select"
            >
              <option value="line">Line</option>
              <option value="dots">Dots</option>
              <option value="space">Space</option>
            </select>
          </div>
        );

      case 'quote':
        return (
          <div className="quote-block-editor">
            <div className="quote-text-editor">
              <TextEditor
                content={block.text}
                onChange={(segments) => onUpdate({ text: segments })}
                placeholder="Enter quote..."
              />
            </div>
            <input
              type="text"
              className="quote-attribution-input"
              value={block.attribution || ''}
              onChange={(e) =>
                onUpdate({ attribution: e.target.value || undefined })
              }
              placeholder="Attribution (optional)"
            />
          </div>
        );

      case 'map':
        return (
          <div className="map-block-editor">
            <div className="map-editor-row">
              <label className="map-editor-label">
                Center
                <div className="map-editor-coords">
                  <input
                    type="number"
                    step="0.0001"
                    min="-90"
                    max="90"
                    value={block.center.lat}
                    onChange={(e) =>
                      onUpdate({
                        center: { ...block.center, lat: parseFloat(e.target.value) || 0 },
                      })
                    }
                    placeholder="Latitude"
                    className="map-coord-input"
                  />
                  <input
                    type="number"
                    step="0.0001"
                    min="-180"
                    max="180"
                    value={block.center.lng}
                    onChange={(e) =>
                      onUpdate({
                        center: { ...block.center, lng: parseFloat(e.target.value) || 0 },
                      })
                    }
                    placeholder="Longitude"
                    className="map-coord-input"
                  />
                </div>
              </label>
            </div>
            <div className="map-editor-row">
              <label className="map-editor-label">
                Zoom: {block.zoom ?? 10}
                <input
                  type="range"
                  min="1"
                  max="18"
                  value={block.zoom ?? 10}
                  onChange={(e) => onUpdate({ zoom: parseInt(e.target.value, 10) })}
                  className="map-zoom-slider"
                />
              </label>
            </div>
            <div className="map-editor-row">
              <label className="map-editor-label">
                Height: {block.height ?? 400}px
                <input
                  type="range"
                  min="200"
                  max="600"
                  step="50"
                  value={block.height ?? 400}
                  onChange={(e) => onUpdate({ height: parseInt(e.target.value, 10) })}
                  className="map-height-slider"
                />
              </label>
            </div>
            <div className="map-preview-container">
              <div className="map-preview-placeholder">
                📍 Map: {block.center.lat.toFixed(4)}, {block.center.lng.toFixed(4)}
                {block.markers && block.markers.length > 0 && (
                  <span> • {block.markers.length} marker(s)</span>
                )}
              </div>
            </div>
          </div>
        );

      case 'section':
        return (
          <div className="section-editor">
            <input
              type="text"
              value={block.title || ''}
              onChange={(e) => onUpdate({ title: e.target.value || undefined })}
              placeholder="Section title (optional)"
              className="section-title-input"
            />
          </div>
        );

      default:
        return <div className="unknown-block">Unknown block type</div>;
    }
  };

  return (
    <SortableBlock id={block.id} onDelete={onDelete}>
      {renderBlockEditor()}
    </SortableBlock>
  );
});
