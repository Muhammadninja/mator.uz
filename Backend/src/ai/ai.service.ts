import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClaudeMcpService } from './claude-mcp.service';
import Anthropic from '@anthropic-ai/sdk';

export interface DiagnoseRequest {
  problemDescription: string;
  carMake?: string;
  carModel?: string;
}

export interface DiagnoseResult {
  problem_analysis: string;
  suggested_parts: Array<{
    id: number;
    title: string;
    carModel: string | null;
    gmNumber: string | null;
    stocks: Array<{
      sellerId: number;
      sellerName: string;
      priceUzs: string;
      quantity: number;
      phone?: string;
    }>;
  }>;
  confidence: number;
}

@Injectable()
export class AIService {
  private readonly claudeClient: Anthropic;
  private readonly claudeMcpService: ClaudeMcpService;

  constructor(private prisma: PrismaService) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    this.claudeClient = new Anthropic({ apiKey });
    this.claudeMcpService = new ClaudeMcpService();
  }

  /**
   * Diagnose a car problem and suggest relevant parts
   * 1. Parse the problem description using Claude
   * 2. Extract keywords and car model info
   * 3. Search for matching parts in database
   * 4. Return analysis + recommended parts with stock info
   */
  async diagnose(request: DiagnoseRequest): Promise<DiagnoseResult> {
    if (!request.problemDescription || request.problemDescription.trim().length === 0) {
      throw new BadRequestException('Problem description is required');
    }

    try {
      // Step 1: Use Claude to analyze the problem and extract key information
      const problemAnalysis = await this.analyzeProblem(request);

      // Step 2: Search for relevant parts based on the analysis
      const suggestedParts = await this.findRelevantParts(
        problemAnalysis,
        request.carMake,
        request.carModel,
      );

      return {
        problem_analysis: problemAnalysis,
        suggested_parts: suggestedParts,
        confidence: this.calculateConfidence(suggestedParts),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Diagnosis failed: ${msg}`);
    }
  }

  /**
   * Analyze the problem description using Claude
   */
  private async analyzeProblem(request: DiagnoseRequest): Promise<string> {
    const systemPrompt = `Ты — эксперт по диагностике автомобильных проблем.
Проанализируй описание проблемы от пользователя и:
1. Определи тип проблемы (электрика, двигатель, коробка, подвеска и т.д.)
2. Предложи возможные причины
3. Рекомендуй типы деталей, которые могут помочь
4. Дай краткий диагноз на русском языке

Ответь в формате:
Диагноз: [краткий диагноз]
Рекомендуемые детали: [типы деталей через запятую]
Описание проблемы: [подробное описание и рекомендации]`;

    const carInfo = request.carMake || request.carModel 
      ? `(Автомобиль: ${request.carMake || ''} ${request.carModel || ''})`
      : '';

    const message = await this.claudeClient.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Проблема: ${request.problemDescription}\n${carInfo}`,
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    return content.text;
  }

  /**
   * Find relevant parts in the database based on problem analysis
   */
  private async findRelevantParts(
    problemAnalysis: string,
    carMake?: string,
    carModel?: string,
  ) {
    // Extract keywords from the analysis
    const keywords = this.extractKeywords(problemAnalysis);

    // Build search query
    const where: any = {
      OR: keywords.map((keyword) => ({
        title: {
          contains: keyword,
          mode: 'insensitive',
        },
      })),
    };

    // Filter by car model if provided
    if (carModel) {
      where.AND = {
        carModel: {
          contains: carModel,
          mode: 'insensitive',
        },
      };
    }

    // Search for products with stocks
    const products = await this.prisma.product.findMany({
      where,
      take: 10, // Limit to top 10 results
      include: {
        stocks: {
          include: {
            seller: {
              select: {
                id: true,
                storeName: true,
                marketName: true,
                phone: true,
              },
            },
          },
          where: {
            quantity: {
              gt: 0, // Only in-stock items
            },
          },
        },
      },
    });

    // Format results
    return products
      .filter((p) => p.stocks.length > 0) // Only include products with stock
      .map((product) => ({
        id: product.id,
        title: product.title,
        carModel: product.carModel,
        gmNumber: product.gmNumber,
        stocks: product.stocks.map((stock) => ({
          sellerId: stock.sellerId,
          sellerName: stock.seller.storeName || stock.seller.marketName || 'Unknown',
          priceUzs: stock.priceUzs.toString(),
          quantity: stock.quantity,
          phone: stock.seller.phone,
        })),
      }));
  }

  /**
   * Extract keywords from Claude's analysis
   */
  private extractKeywords(text: string): string[] {
    // Split by common delimiters and punctuation
    const keywords = text
      .toLowerCase()
      .split(/[,;\n:]/g)
      .map((k) => k.trim())
      .filter(
        (k) =>
          k.length > 2 &&
          !['и', 'или', 'что', 'как', 'это', 'для', 'при', 'если'].includes(k),
      )
      .slice(0, 5); // Limit to 5 keywords

    return keywords;
  }

  /**
   * Calculate confidence level based on number of matching parts
   */
  private calculateConfidence(parts: any[]): number {
    if (parts.length === 0) return 0.3; // Low confidence if no parts found
    if (parts.length >= 5) return 0.9; // High confidence if many parts found
    return Math.min(0.5 + (parts.length * 0.1), 0.85);
  }
}
