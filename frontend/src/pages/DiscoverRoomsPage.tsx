import { useCallback, useEffect, useState } from 'react'
import { Search, Users, Radio, Clock } from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Paragraph, Text } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'

interface DirectoryRoom {
  roomId: string
  name: string
  url: string
  updatedAt?: number
}

/**
 * 发现公开房间（v11.3）：
 * 通过后端 /api/directory/rooms 查询公告栏中的公开房间，
 * 点击后跳转到房主服务器加入（拿到的永远是最新地址）。
 */
export default function DiscoverRoomsPage() {
  const [keyword, setKeyword] = useState('')
  const [rooms, setRooms] = useState<DirectoryRoom[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configured, setConfigured] = useState(true)

  const search = useCallback(async (kw: string) => {
    setLoading(true)
    setError(null)
    try {
      const q = kw.trim() ? `?search=${encodeURIComponent(kw.trim())}` : ''
      const res = await fetch(`/api/directory/rooms${q}`)
      const data = await res.json().catch(() => null)
      if (!data) {
        setError('公告栏响应异常')
        setConfigured(false)
        return
      }
      if (!data.success) {
        if (data.message && String(data.message).includes('未配置')) {
          setConfigured(false)
          setRooms([])
        } else {
          setError(data.message || '查询失败')
        }
        return
      }
      setConfigured(true)
      setRooms(data.rooms || [])
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void search('')
  }, [search])

  const joinRoom = (room: DirectoryRoom) => {
    // 跳到房主服务器加入（目录里存的是最新隧道地址）
    window.location.href = `${room.url.replace(/\/$/, '')}/room/${encodeURIComponent(room.roomId)}`
  }

  return (
    <div className="flex flex-1 items-start justify-center p-6">
      <Card className="relative w-full max-w-md">
        <PageBackButton to="/" />
        <div className="pt-8">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
            <Title level={3} className="m-0">
              发现公开房间
            </Title>
          </div>
          <Paragraph type="secondary" className="mt-2 text-xs">
            搜索正在公开的房间，无需链接即可加入（需房主开启公网通道并公开到公告栏）
          </Paragraph>
          <div className="mt-4 flex w-full gap-2">
            <Input
              placeholder="搜索房间号或名称"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search(keyword)
              }}
              maxLength={64}
            />
            <Button
              variant="secondary"
              icon={<Search className="h-4 w-4 shrink-0" />}
              loading={loading}
              onClick={() => void search(keyword)}
              className="shrink-0 whitespace-nowrap"
            >
              搜索
            </Button>
          </div>

          {!configured && (
            <div className="mt-4 rounded-lg border border-dashed p-4 text-center">
              <Paragraph className="m-0 text-sm">
                公告栏未配置，暂无公开房间。
              </Paragraph>
              <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                部署者可通过环境变量 <code>DIRECTORY_URL</code> 接入房间公告栏
              </Paragraph>
            </div>
          )}

          {error && (
            <Paragraph type="danger" className="mt-3 m-0 text-xs">
              {error}
            </Paragraph>
          )}

          <div className="mt-4 flex flex-col gap-2">
            {loading && rooms.length === 0 && (
              <Paragraph type="secondary" className="m-0 text-center text-xs">
                加载中...
              </Paragraph>
            )}
            {!loading && configured && rooms.length === 0 && (
              <Paragraph type="secondary" className="m-0 text-center text-xs">
                暂无公开房间
              </Paragraph>
            )}
            {rooms.map((room) => (
              <button
                key={room.roomId}
                className="flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] border px-3 py-2.5 text-left transition-colors hover:bg-[var(--md-sys-color-surface-container)]"
                style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
                onClick={() => joinRoom(room)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Radio className="h-4 w-4 shrink-0 text-[var(--md-sys-color-primary)]" />
                  <div className="min-w-0">
                    <Text className="block truncate text-sm font-medium">
                      {room.name || room.roomId}
                    </Text>
                    <Text type="secondary" className="block truncate font-mono text-xs">
                      房间号 {room.roomId}
                    </Text>
                  </div>
                </div>
                {room.updatedAt ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    <Clock className="h-3 w-3" />
                    {new Date(room.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
