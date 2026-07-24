import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class SystemSettings {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'boolean', default: true })
  autoDeleteInactiveRooms!: boolean;

  @Column({ type: 'integer', default: 24 })
  autoDeleteAfterHours!: number;

  @Column({ type: 'json', nullable: true })
  dataSourceConfig!: Record<string, unknown> | null;

  @Column({ type: 'text', default: 'approval' })
  registrationMode!: 'open' | 'approval' | 'closed';

  @Column({ type: 'boolean', default: false })
  betaFeaturesEnabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
