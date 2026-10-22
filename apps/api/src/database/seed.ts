import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { DEV_ONLY_DEFAULTS, productionRequired } from '../config/secrets';
import { Client as TypesenseClient } from 'typesense';
import * as schema from './schema';
import { eq } from 'drizzle-orm';
import { BUSINESSES_COLLECTION_SCHEMA, BUSINESSES_SEARCH_COLLECTION } from '../modules/search/search.constants';
import { verifiedConnection } from './tls';
import { assertLocalDatabaseAllowed } from './db-guard';

dotenv.config();

// Production seed only installs foundational taxonomies, default pricing settings,
// unified credit packages, and the Super Admin. No temporary or mock businesses are seeded.
const sampleBusinesses: any[] = [];

async function seedDatabase() {
  let databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/orion_db';
  if (databaseUrl.includes('-pooler.')) {
    databaseUrl = databaseUrl.replace('-pooler.', '.');
  }
  assertLocalDatabaseAllowed(databaseUrl); // a local server may host other applications' databases
  console.log('Connecting to database for seeding...');

  const pool = new Pool({
    ...verifiedConnection(databaseUrl),
    max: 1,
  });

  const db = drizzle(pool, { schema });

  try {
    console.log('Verifying initial system administrator...');
    const adminEmail = process.env.ADMIN_SEED_EMAIL || 'admin@monarchsoftwares.com';
    const existingAdmin = await db.query.users.findFirst({
      where: eq(schema.users.email, adminEmail),
    }) || await db.query.users.findFirst({
      where: eq(schema.users.email, 'subash@monarchsoftwares.com'),
    });

    if (!existingAdmin) {
      // No built-in password: admins sign in through the OTP flow. A password is only set if explicitly provided for this run.
      const seedPassword = process.env.ADMIN_SEED_PASSWORD;
      const passwordHash = seedPassword && seedPassword.length >= 12 ? await bcrypt.hash(seedPassword, 12) : null;
      const [adminUser] = await db
        .insert(schema.users)
        .values({
          email: adminEmail,
          passwordHash,
          firstName: 'Monarch',
          lastName: 'Administrator',
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          isEmailVerified: true,
          metadata: { initializedBy: 'system-seeder' },
        })
        .returning();

      // Create initial admin wallet with 10,000 credits
      await db.insert(schema.userWallets).values({
        userId: adminUser.id,
        dailyCredits: 5,
        purchasedCredits: 10000,
        balance: 10005,
        lastDailyCreditDate: new Date().toISOString().slice(0, 10),
        lifetimePurchased: 10000,
        lifetimeUsed: 0,
      });

      console.log(`✓ Created super admin user: ${adminEmail}`);
    } else {
      console.log(`ℹ Super admin already exists: ${existingAdmin.email}`);
      const adminWallet = await db.query.userWallets.findFirst({
        where: eq(schema.userWallets.userId, existingAdmin.id),
      });
      if (adminWallet && (!adminWallet.dailyCredits || adminWallet.dailyCredits === 0)) {
        await db.update(schema.userWallets).set({
          dailyCredits: 5,
          purchasedCredits: adminWallet.balance || 10000,
          balance: (adminWallet.balance || 10000) + 5,
          lastDailyCreditDate: new Date().toISOString().slice(0, 10),
        }).where(eq(schema.userWallets.id, adminWallet.id));
      }
    }

    console.log('Seeding pricing settings and credit packages...');
    const defaultSettings = [
      {
        key: 'DAILY_FREE_CREDITS',
        value: { amount: 5, description: 'Daily free credits allocated to each active user' },
        description: 'Daily free credits amount',
      },
      {
        key: 'ANNUAL_DISCOUNT_PERCENTAGE',
        value: { percentage: 20, description: 'Discount applied to annual package purchases' },
        description: 'Annual billing discount percentage',
      },
      {
        key: 'DEFAULT_CURRENCY',
        value: { currency: 'INR', symbol: '₹' },
        description: 'Default platform billing currency',
      },
    ];

    for (const setting of defaultSettings) {
      const existing = await db.query.pricingSettings.findFirst({
        where: eq(schema.pricingSettings.key, setting.key),
      });
      if (!existing) {
        await db.insert(schema.pricingSettings).values(setting);
      }
    }
    console.log('✓ Pricing settings verified/seeded.');

    const defaultPackages = [
      {
        slug: 'free',
        name: 'Free Plan',
        description: 'Standard access for early prospecting and exploring verified business intelligence.',
        priceInr: 0,
        credits: 5,
        userLimit: 1,
        billingType: 'DAILY_FREE',
        popular: false,
        badgeText: '5 Daily Free',
        features: [
          '5 Daily Verified Leads',
          'Search & Discovery Engine',
          'Basic Contact Details',
          'Daily rollover at 11:59 PM',
          'Community Support',
        ],
        isActive: true,
        sortOrder: 1,
      },
      {
        slug: 'starter',
        name: 'Starter Pack',
        description: 'Ideal for individual founders, freelancers, and sales reps building focused pipelines.',
        priceInr: 299,
        credits: 100,
        userLimit: 1,
        billingType: 'ONE_TIME',
        popular: false,
        badgeText: null,
        features: [
          '100 Lifetime Lead Credits',
          'Credits Never Expire',
          'Direct Mobile & Email Unlocks',
          'CSV / Spreadsheet Export',
          'Single User License',
          'Standard Support',
        ],
        isActive: true,
        sortOrder: 2,
      },
      {
        slug: 'growth',
        name: 'Growth Pack',
        description: 'Best for growing sales teams and agencies looking for rapid pipeline scale.',
        priceInr: 499,
        credits: 350,
        userLimit: 1,
        billingType: 'ONE_TIME',
        popular: true,
        badgeText: 'Most Popular',
        features: [
          '350 Lifetime Lead Credits',
          'Credits Never Expire',
          'Direct Decision Maker Contacts',
          'Full Export & Filter Capabilities',
          'Single User License',
          'Priority Email Support',
        ],
        isActive: true,
        sortOrder: 3,
      },
      {
        slug: 'agency',
        name: 'Agency Pack',
        description: 'High-volume lead intelligence for outreach agencies and enterprise outbound teams.',
        priceInr: 999,
        credits: 1500,
        userLimit: 1,
        billingType: 'ONE_TIME',
        popular: false,
        badgeText: 'Best Value',
        features: [
          '1,500 Lifetime Lead Credits',
          'Credits Never Expire',
          'Full Executive & CXO Contacts',
          'Bulk Export Engine',
          'Single User License',
          'Priority VIP Support',
        ],
        isActive: true,
        sortOrder: 4,
      },
      {
        slug: 'enterprise',
        name: 'Enterprise Plan',
        description: 'Custom high-volume intelligence, dedicated infrastructure, and team workspace management.',
        priceInr: null,
        credits: 0,
        userLimit: null,
        billingType: 'CUSTOM',
        popular: false,
        badgeText: 'Custom',
        features: [
          'Custom High-Volume Credit Allocation',
          'Unlimited Team Users & RBAC',
          'Team Workspace Collaboration',
          'Bulk Export Engine',
          'Dedicated API Access',
          '24x7 Priority Account Manager',
        ],
        isActive: true,
        sortOrder: 5,
      },
    ];

    for (const pkg of defaultPackages) {
      const existing = await db.query.creditPackages.findFirst({
        where: eq(schema.creditPackages.slug, pkg.slug),
      });
      if (!existing) {
        await db.insert(schema.creditPackages).values(pkg);
      } else {
        await db.update(schema.creditPackages).set(pkg).where(eq(schema.creditPackages.slug, pkg.slug));
      }
    }
    console.log('✓ Credit packages verified/seeded.');

    console.log('Seeding baseline industry taxonomies...');
    const baselineIndustries = [
      { code: 'TECH', name: 'Information Technology & SaaS', slug: 'information-technology-saas' },
      { code: 'HEALTH', name: 'Healthcare & Life Sciences', slug: 'healthcare-life-sciences' },
      { code: 'FIN', name: 'Financial Services & Fintech', slug: 'financial-services-fintech' },
      { code: 'MFG', name: 'Manufacturing & Industrial', slug: 'manufacturing-industrial' },
      { code: 'RETAIL', name: 'Retail & E-commerce', slug: 'retail-ecommerce' },
      { code: 'RE', name: 'Real Estate & Construction', slug: 'real-estate-construction' },
      { code: 'PROF', name: 'Professional & Legal Services', slug: 'professional-legal-services' },
      { code: 'LOG', name: 'Logistics & Supply Chain', slug: 'logistics-supply-chain' },
    ];

    const industryMap: Record<string, string> = {};

    for (const ind of baselineIndustries) {
      let existing = await db.query.industries.findFirst({
        where: eq(schema.industries.code, ind.code),
      });

      if (!existing) {
        const [inserted] = await db.insert(schema.industries).values(ind).returning();
        existing = inserted;
      }
      if (existing) {
        industryMap[ind.code] = existing.id;
      }
    }
    console.log('✓ Baseline industries verified/seeded.');

    console.log('Seeding baseline sample business records...');
    const typesenseDocs: any[] = [];

    for (const sample of sampleBusinesses) {
      const existing = await db.query.businesses.findFirst({
        where: eq(schema.businesses.slug, sample.slug),
      });

      let businessId = existing?.id;

      if (!existing) {
        const [created] = await db
          .insert(schema.businesses)
          .values({
            name: sample.name,
            legalName: sample.legalName,
            slug: sample.slug,
            industryId: industryMap[sample.industryCode] || null,
            businessType: sample.businessType,
            msmeCategory: sample.msmeCategory,
            opportunityTier: sample.opportunityTier,
            employeeCountRange: sample.employeeCountRange,
            annualRevenueRange: sample.annualRevenueRange,
            foundingYear: sample.foundingYear,
            incorporationDate: new Date(`${sample.foundingYear}-04-01T00:00:00Z`),
            description: sample.description,
            status: 'PUBLISHED',
            isVerified: true,
            isEnriched: true,
            publishedAt: new Date(),
          })
          .returning();

        businessId = created.id;

        // Insert Location
        await db.insert(schema.businessLocations).values({
          businessId,
          addressLine1: sample.location.addressLine1,
          city: sample.location.city,
          district: sample.location.district,
          state: sample.location.state,
          pincode: sample.location.pincode,
          country: 'India',
          isPrimary: true,
        });

        // Insert Contact
        await db.insert(schema.businessContacts).values({
          businessId,
          fullName: sample.contact.fullName,
          title: sample.contact.title,
          department: sample.contact.department,
          email: sample.contact.email,
          phone: sample.contact.phone,
          isEmailVerified: true,
          isPhoneVerified: true,
          isPrimary: true,
          isDecisionMaker: true,
        });

        // Insert Digital Presence
        if (sample.website) {
          await db.insert(schema.digitalPresences).values({
            businessId,
            platform: 'WEBSITE',
            url: sample.website,
            domain: sample.website.replace('https://', ''),
            isVerified: true,
            techStackDetected: sample.technologies,
          });
        }

        // Insert Score
        await db.insert(schema.businessScores).values({
          businessId,
          orionScore: sample.orionScore,
          scoreVersion: 'v1.0',
          weightsApplied: {},
          calculatedAt: new Date(),
        });

        // Insert Metric
        await db.insert(schema.businessMetrics).values({
          businessId,
          completenessScore: 85,
          verificationScore: 90,
          freshnessScore: 95,
          digitalPresenceScore: sample.website ? 85 : 40,
          confidenceScore: 90,
        });

        console.log(`✓ Seeded business: ${sample.name} (${sample.location.city}, ${sample.location.state})`);
      }

      const industryName = baselineIndustries.find((i) => i.code === sample.industryCode)?.name || 'General';

      typesenseDocs.push({
        id: businessId,
        name: sample.name,
        legal_name: sample.legalName,
        slug: sample.slug,
        status: 'PUBLISHED',
        industry_id: industryMap[sample.industryCode] || '',
        industry_name: industryName,
        business_type: sample.businessType,
        msme_category: sample.msmeCategory,
        state: sample.location.state,
        district: sample.location.district,
        city: sample.location.city,
        pincode: sample.location.pincode,
        has_website: Boolean(sample.website),
        has_email: Boolean(sample.contact.email),
        has_phone: Boolean(sample.contact.phone),
        has_gstin: true,
        orion_score: sample.orionScore,
        opportunity_tier: sample.opportunityTier,
        completeness_score: 85,
        verification_score: 90,
        freshness_score: 95,
        digital_presence_score: sample.website ? 85 : 40,
        confidence_score: 90,
        founding_year: sample.foundingYear,
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      });
    }

    // Index documents into Typesense if configured
    const searchProvider = (process.env.SEARCH_PROVIDER || 'postgres').toLowerCase();
    if (searchProvider === 'typesense') {
      console.log('Syncing documents to Typesense cluster...');
      const typesenseHost = process.env.TYPESENSE_HOST || 'localhost';
      const typesensePort = Number(process.env.TYPESENSE_PORT || 8108);
      const typesenseProtocol = process.env.TYPESENSE_PROTOCOL || 'http';
      const typesenseApiKey = productionRequired('TYPESENSE_API_KEY', DEV_ONLY_DEFAULTS.typesenseApiKey);

      const tsClient = new TypesenseClient({
        nodes: [
          {
            host: typesenseHost,
            port: typesensePort,
            protocol: typesenseProtocol,
          },
        ],
        apiKey: typesenseApiKey,
        connectionTimeoutSeconds: 5,
      });

      try {
        try {
          await tsClient.collections(BUSINESSES_SEARCH_COLLECTION).retrieve();
          console.log(`✓ Typesense collection '${BUSINESSES_SEARCH_COLLECTION}' already exists.`);
        } catch {
          console.log(`Creating Typesense collection '${BUSINESSES_SEARCH_COLLECTION}'...`);
          await tsClient.collections().create(BUSINESSES_COLLECTION_SCHEMA);
          console.log(`✓ Created Typesense collection '${BUSINESSES_SEARCH_COLLECTION}'.`);
        }

        for (const doc of typesenseDocs) {
          await tsClient.collections(BUSINESSES_SEARCH_COLLECTION).documents().upsert(doc);
        }
        console.log(`✓ Successfully indexed ${typesenseDocs.length} businesses into Typesense!`);
      } catch (tsErr: any) {
        console.warn('⚠️ Typesense indexing warning:', tsErr.message);
      }
    } else {
      console.log('ℹ SEARCH_PROVIDER is postgres. Skipping Typesense index sync.');
    }

    console.log('✓ Seeding completed successfully.');
  } catch (error) {
    console.error('✗ Seeding failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seedDatabase();
