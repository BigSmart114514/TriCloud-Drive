// server/api/manage/listUsers.get.ts
import { defineEventHandler, getQuery } from 'h3';
import { getDb } from '~~/server/utils/db-adapter';
import { requireAdmin } from '~~/server/utils/auth-middleware';

// 定义用户接口
interface User {
  id: number;
  email: string;
  username:string;
  created_at: string;
  IsAdmin: boolean;
  IsSuperAdmin: boolean;
  usedStorage: number;
  maxStorage: number;
  usedDownload: number;
  maxDownload: number;
  expire_at: string;
}

// 定义响应接口（移除了分页相关的字段）
interface ApiResponse {
  users: User[];
  totalCount: number; // 仍然保留总数，即使没有分页，知道总数也很有用
}

export default defineEventHandler(async (event) => {
  try {
    // 管理员门控：这个接口会吐出全部用户的邮箱、配额和管理员标记
    await requireAdmin(event);

    // 获取数据库实例
    const db = getDb(event);
    
    // 获取查询参数
    const queryParams = getQuery(event);
    
    // 构建基础SQL查询
    let sql = `
      SELECT id, email, username, created_at, IsAdmin, IsSuperAdmin, usedStorage, maxStorage, usedDownload, maxDownload, expire_at
      FROM users 
      WHERE 1=1
    `;
    
    // 构建计数SQL查询
    let countSql = `SELECT COUNT(*) as total FROM users WHERE 1=1`;
    
    // 添加筛选条件（按邮箱筛选）
    const params = []; // 用于主查询的参数
    const countParams = []; // 用于计数查询的参数
    
    if (queryParams.username) {
      sql += ` AND username LIKE ?`;
      countSql += ` AND username LIKE ?`;
      params.push(`%${queryParams.username}%`);
      countParams.push(`%${queryParams.username}%`);
    }
    
    // 添加排序
    sql += ` ORDER BY created_at DESC`;
    
    // 执行用户查询（不再包含 LIMIT 和 OFFSET）
    const stmt = db.prepare(sql);
    const bindStmt = stmt.bind(...params);
    const usersResult = await bindStmt.all();
    const users = usersResult.results as User[];
    
    // 执行计数查询
    const countStmt = db.prepare(countSql);
    const bindCountStmt = countStmt.bind(...countParams);
    const countResult = await bindCountStmt.first() as { total: number };
    const totalCount = countResult.total;
    //console.log(`users: ${users.values}`);
    
    // 构建响应（移除了分页相关的字段）
    const response: ApiResponse = {
      users,
      totalCount,
    };
    
    return response;
  } catch (error: any) {
    // 已经是 createError 的（401/403/400）原样抛出，
    // 否则未登录/非管理员会在这里被改写成 500，看不出是权限问题
    if (error?.statusCode) throw error;
    console.error('Error fetching users:', error);
    throw createError({
      statusCode: 500,
      statusMessage: 'Internal Server Error',
    });
  }
});