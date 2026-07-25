require('reflect-metadata');
const dotenv = require('dotenv');
dotenv.config();

const { AppDataSource } = require('./dist/data-source');
const { playbackMemoryService } = require('./dist/modules/playback-memory/playback-memory.service');

async function main() {
  await AppDataSource.initialize();
  console.log('Data source initialized');

  const roomId = 'test-room-' + Date.now();

  // First set: should insert
  await playbackMemoryService.setPlayback(roomId, {
    sourceUrl: 'https://example.com/video.m4s',
    sourceType: 'bilibili',
    audioUrl: 'https://example.com/audio.m4s',
    format: 'dash',
    videoCodec: 'avc1.640033',
    audioCodec: 'mp4a.40.2',
    cid: 12345,
    isPlaying: true,
    currentTime: 10,
    playbackRate: 1,
    duration: 1420,
    currentQn: 80,
    acceptQuality: [{ id: 80, label: '1080P' }],
    headers: { Referer: 'https://www.bilibili.com' },
    isPreview: false,
    previewTitle: undefined,
  }, 'socket-1');

  console.log('First set done');

  // Force flush and second set: should update (not throw UNIQUE constraint)
  await playbackMemoryService.setPlayback(roomId, {
    sourceUrl: 'https://example.com/video.m4s',
    sourceType: 'bilibili',
    audioUrl: 'https://example.com/audio.m4s',
    format: 'dash',
    videoCodec: 'avc1.640033',
    audioCodec: 'mp4a.40.2',
    cid: 12345,
    isPlaying: true,
    currentTime: 20,
    playbackRate: 1,
    duration: 1420,
    currentQn: 80,
    acceptQuality: [{ id: 80, label: '1080P' }],
    headers: { Referer: 'https://www.bilibili.com' },
    isPreview: false,
    previewTitle: undefined,
  }, 'socket-1');

  console.log('Second set done (upsert should succeed)');

  const state = await playbackMemoryService.getRawPlayback(roomId);
  console.log('Raw playback currentTime:', state?.currentTime);

  await AppDataSource.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
