import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty } from '../ui/bits'

export default function Library() {
  return (
    <>
      <TopMain crumb="Workspace" title="Library" />
      <div className="scroll">
        <div className="ph">
          <h2>Library</h2>
          <p>Everything your chats and Cowork runs produced.</p>
        </div>
        <div className="sin" style={{ marginBottom: 10, opacity: 0.6 }}>
          <I n="search" />
          <input placeholder="Search artifacts" disabled aria-label="Search artifacts" />
        </div>
        <div className="frame">
          <Empty icon={<I n="book" size={20} />}>
            Artifacts open on the computer for now.
            <br />
            Browsing them from the phone comes in a later update.
          </Empty>
        </div>
      </div>
    </>
  )
}
