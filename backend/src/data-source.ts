import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { BilibiliCredential } from './entities/BilibiliCredential';
import { Movie } from './entities/Movie';
import { UserMount } from './entities/UserMount';
import { SystemSettings } from './entities/SystemSettings';
import { PlaybackState } from './entities/PlaybackState';
import { ServerFolder } from './entities/ServerFolder';
import { DATABASE_PATH } from './services/paths';

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  // 数据库文件统一存放在 config/ 目录下，便于升级时整体保留。
  // 路径解析详见 services/paths.ts（支持 DATABASE_URL 环境变量覆盖）。
  database: DATABASE_PATH,
  synchronize: true,
  logging: process.env.NODE_ENV === 'development',
  entities: [Room, Session, User, Comment, BilibiliCredential, Movie, UserMount, SystemSettings, PlaybackState, ServerFolder],
  migrations: [],
  subscribers: [],
});
