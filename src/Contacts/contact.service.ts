import { injectable } from "tsyringe";
import { Repository } from "typeorm";
import { Contact } from "./contact.entity";
import AppDataSource from "../config/Datasource";

@injectable()
export default class ContactService {
  private contactRepository: Repository<Contact>;

  constructor() {
    this.contactRepository = AppDataSource.getRepository(Contact);
  }

  async createContact(
    payload: { name: string; address: string; tokenType: string },
    userId: string
  ): Promise<Contact> {
    const contact = this.contactRepository.create({
      ...payload,
      userId,
    });
    return this.contactRepository.save(contact);
  }

  async deleteContact(id: string): Promise<void> {
    await this.contactRepository.delete(id);
  }

  async getAllContacts(): Promise<Contact[]> {
    return this.contactRepository.find();
  }

  async getContactsByName(name: string, userId?: string): Promise<Contact[]> {
    const where: Record<string, unknown> = { name };
    if (userId) {
      where.userId = userId;
    }
    return this.contactRepository.find({ where });
  }

  async getContactByName(
    name: string,
    userId?: string,
    selectedId?: string
  ): Promise<Contact | null> {
    const contacts = await this.getContactsByName(name, userId);
    if (contacts.length === 0) {
      return null;
    }
    if (contacts.length === 1) {
      return contacts[0];
    }
    if (selectedId) {
      const selected = contacts.find((c) => c.id === selectedId);
      if (selected) return selected;
    }
    throw new ContactCollisionError(name, contacts);
  }

  async resolveRecipient(
    name: string,
    userId?: string,
    selectedId?: string
  ): Promise<ContactResolutionResult> {
    const candidates = await this.getContactsByName(name, userId);
    if (candidates.length === 0) {
      return {
        status: "not_found",
        message: `No contact found with name "${name}"`,
      };
    }
    if (candidates.length === 1) {
      return {
        status: "resolved",
        contact: candidates[0],
      };
    }
    if (selectedId) {
      const selected = candidates.find((c) => c.id === selectedId);
      if (selected) {
        return {
          status: "resolved",
          contact: selected,
        };
      }
    }
    return {
      status: "collision",
      candidates,
      message: `Multiple contacts found for "${name}". Explicit recipient selection required.`,
    };
  }
}

export interface ContactResolutionResult {
  status: "resolved" | "not_found" | "collision";
  contact?: Contact;
  candidates?: Contact[];
  message?: string;
}

export class ContactCollisionError extends Error {
  public candidates: Contact[];

  constructor(name: string, candidates: Contact[]) {
    super(
      `Multiple contacts found with name "${name}". Explicit recipient selection required.`
    );
    this.name = "ContactCollisionError";
    this.candidates = candidates;
  }
}

