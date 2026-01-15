import { memo } from 'react';
import type { MosaicItem } from '../../lib/mosaic-layout';
import type { PhotoMeta } from '../../workers/types';

interface MosaicTileProps {
  item: MosaicItem;
  photo: PhotoMeta;
  onClick?: () => void;
  renderThumbnail: (props: { 
    photo: PhotoMeta; 
    width: number; 
    height: number;
    onClick?: () => void;
  }) => React.ReactNode;
  /**
   * When true, skip absolute positioning (used when wrapped by AnimatedTile).
   */
  skipPositioning?: boolean;
}

export const MosaicTile = memo(function MosaicTile({
  item,
  photo,
  onClick,
  renderThumbnail,
  skipPositioning = false
}: MosaicTileProps) {
  
  // Base style with optional positioning
  const positionStyle = skipPositioning ? {} : {
    position: 'absolute' as const,
    top: item.rect.top,
    left: item.rect.left,
  };
  
  const sizeStyle = {
    width: item.rect.width,
    height: item.rect.height,
  };
  
  if (item.type === 'story') {
    return (
      <div 
        className="mosaic-tile mosaic-story-tile"
        style={{
          ...positionStyle,
          ...sizeStyle,
          display: 'flex',
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: '8px',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}
      >
        {/* Photo Section - 50% width */}
        <div style={{ width: '50%', height: '100%', position: 'relative' }}>
          {renderThumbnail({
            photo,
            width: item.rect.width / 2,
            height: item.rect.height,
            ...(onClick ? { onClick } : {})
          })}
        </div>
        
        {/* Text Section */}
        <div style={{ 
          width: '50%', 
          padding: '24px', 
          display: 'flex', 
          flexDirection: 'column', 
          justifyContent: 'center',
          overflow: 'hidden'
        }}>
          <h3 style={{ 
            marginTop: 0, 
            marginBottom: '12px', 
            fontSize: '1.1rem', 
            fontWeight: 600,
            color: 'var(--text-primary)'
          }}>
            {new Date(photo.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}
          </h3>
          <p style={{ 
            margin: 0, 
            lineHeight: 1.6, 
            color: 'var(--text-secondary)',
            fontSize: '1rem',
            whiteSpace: 'pre-wrap'
          }}>
            {item.description}
          </p>
        </div>
      </div>
    );
  }

  // HERO & STANDARD TILES
  return (
    <div 
      className={`mosaic-tile mosaic-${item.type}-tile`}
      style={{
        ...positionStyle,
        ...sizeStyle,
      }}
    >
      {renderThumbnail({
        photo,
        width: item.rect.width,
        height: item.rect.height,
        ...(onClick ? { onClick } : {})
      })}
    </div>
  );
});
