import { Pool } from 'pg';
import { User } from '../../shared/types';
export declare class UserService {
    private db;
    constructor(db: Pool);
    loadOrCreate(phone: string): Promise<User>;
    findByPhone(phone: string): Promise<Omit<User, 'isNew'> | null>;
    findById(userId: string): Promise<Omit<User, 'isNew'> | null>;
    create(phone: string): Promise<Omit<User, 'isNew'>>;
    updateLanguage(userId: string, language: 'es' | 'en' | 'pt' | 'fr'): Promise<void>;
    updateName(userId: string, name: string): Promise<void>;
    private isValidPhone;
}
//# sourceMappingURL=service.d.ts.map