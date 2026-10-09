/**
 * Browser Projects Service - projects live on the Flint server so every
 * browser and the desktop app share one list.
 */

import { ulid } from 'ulidx'
import { browserApi, jsonRequest } from '@/services/browserApi'
import type { ProjectModel, ProjectsService, ThreadFolder } from './types'

const URL = '/api/v1/projects'

export class BrowserProjectsService implements ProjectsService {
  getProjects(): Promise<ThreadFolder[]> {
    return browserApi<ThreadFolder[]>(URL)
  }

  setProjects(projects: ThreadFolder[]): Promise<void> {
    return browserApi<void>(URL, jsonRequest('PUT', projects))
  }

  // One request per change, so browsers working at once cannot overwrite each
  // other's: the server applies each to the list under a lock.
  addProject(
    name: string,
    assistantId?: string,
    model?: ProjectModel
  ): Promise<ThreadFolder> {
    const project: ThreadFolder = {
      id: ulid(),
      name,
      updated_at: Date.now(),
      assistantId,
      ...(model ? { model } : {}),
    }
    return browserApi<ThreadFolder>(URL, jsonRequest('POST', project))
  }

  async updateProject(
    id: string,
    name: string,
    assistantId?: string,
    model?: ProjectModel
  ): Promise<void> {
    await browserApi<void>(
      `${URL}/${encodeURIComponent(id)}`,
      jsonRequest('PUT', { name, updated_at: Date.now(), assistantId, model })
    )
  }

  async deleteProject(id: string): Promise<void> {
    await browserApi<void>(`${URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async getProjectById(id: string): Promise<ThreadFolder | undefined> {
    return (await this.getProjects()).find((project) => project.id === id)
  }
}
