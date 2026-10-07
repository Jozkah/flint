/**
 * Browser Projects Service - projects live on the Flint server so every
 * browser and the desktop app share one list.
 */

import { ulid } from 'ulidx'
import { browserApi, jsonRequest } from '@/services/browserApi'
import type { ProjectsService, ThreadFolder } from './types'

const URL = '/api/v1/projects'

export class BrowserProjectsService implements ProjectsService {
  getProjects(): Promise<ThreadFolder[]> {
    return browserApi<ThreadFolder[]>(URL)
  }

  setProjects(projects: ThreadFolder[]): Promise<void> {
    return browserApi<void>(URL, jsonRequest('PUT', projects))
  }

  async addProject(name: string, assistantId?: string): Promise<ThreadFolder> {
    const project: ThreadFolder = { id: ulid(), name, updated_at: Date.now(), assistantId }
    await this.setProjects([...(await this.getProjects()), project])
    return project
  }

  async updateProject(id: string, name: string, assistantId?: string): Promise<void> {
    const projects = await this.getProjects()
    await this.setProjects(
      projects.map((project) =>
        project.id === id ? { ...project, name, updated_at: Date.now(), assistantId } : project
      )
    )
  }

  async deleteProject(id: string): Promise<void> {
    const projects = await this.getProjects()
    await this.setProjects(projects.filter((project) => project.id !== id))
  }

  async getProjectById(id: string): Promise<ThreadFolder | undefined> {
    return (await this.getProjects()).find((project) => project.id === id)
  }
}
