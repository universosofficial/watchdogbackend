import swaggerUi from 'swagger-ui-express';

export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Digital Watchdog API',
    version: '1.0.0',
    description: 'Enterprise B2B Trust, Milestone Escrow, and Dispute Resolution backend engine with dual agreement acceptance, HMAC signed webhooks, and tamper-evident audit logging.',
    contact: {
      name: 'Digital Watchdog Security & Architecture Team',
      email: 'security@digitalwatchdog.ng'
    }
  },
  servers: [
    {
      url: '/api/v1',
      description: 'API v1 Base Endpoint'
    }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Provide your JSON Web Token (JWT) in the Authorization header. Format: Bearer <token>'
      }
    },
    schemas: {
      StandardSuccess: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { type: 'object' }
        }
      },
      StandardError: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              message: { type: 'string', example: 'Descriptive operational error message' },
              code: { type: 'string', example: 'UNAUTHORIZED' }
            }
          }
        }
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          full_name: { type: 'string' },
          phone: { type: 'string' }
        }
      },
      Business: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          rc_number: { type: 'string' },
          address: { type: 'string' },
          verification_status: { type: 'string', enum: ['unverified', 'pending', 'verified'] }
        }
      },
      Deal: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reference_no: { type: 'string', example: 'DW-DEAL-2026-9041-A8F' },
          title: { type: 'string' },
          description: { type: 'string' },
          amount: { type: 'number', example: 17600000.00 },
          currency: { type: 'string', example: 'NGN' },
          status: {
            type: 'string',
            enum: ['draft', 'awaiting_acceptance', 'active', 'disputed', 'completed', 'cancelled', 'terminated']
          },
          current_version: { type: 'integer', example: 1 }
        }
      },
      Obligation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deal_id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          description: { type: 'string' },
          responsible_business_id: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['payment', 'delivery', 'inspection', 'document', 'service'] },
          due_date: { type: 'string', format: 'date-time' },
          original_due_date: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['not_started', 'in_progress', 'submitted_for_review', 'completed', 'overdue', 'disputed', 'cancelled'] },
          completion_date: { type: 'string', format: 'date-time' },
          is_overdue: { type: 'boolean' }
        }
      },
      PaymentRecord: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deal_id: { type: 'string', format: 'uuid' },
          expected_amount: { type: 'number' },
          reported_amount: { type: 'number' },
          currency: { type: 'string' },
          reference_no: { type: 'string' },
          status: { type: 'string', enum: ['reported', 'acknowledged', 'confirmed'] },
          paid_at: { type: 'string', format: 'date-time' }
        }
      },
      DeliveryRecord: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deal_id: { type: 'string', format: 'uuid' },
          delivery_reference: { type: 'string' },
          status: { type: 'string', enum: ['dispatched', 'delivered', 'acknowledged_with_discrepancy', 'confirmed'] },
          dispatch_date: { type: 'string', format: 'date-time' },
          receipt_date: { type: 'string', format: 'date-time' },
          items_json: { type: 'array', items: { type: 'object' } }
        }
      },
      Dispute: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deal_id: { type: 'string', format: 'uuid' },
          obligation_id: { type: 'string', format: 'uuid' },
          raised_by_business_id: { type: 'string', format: 'uuid' },
          category: { type: 'string', example: 'Specification Discrepancy' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['open', 'awaiting_response', 'under_review', 'resolution_proposed', 'resolved', 'unresolved'] },
          resolution_terms: { type: 'string' },
          resolved_at: { type: 'string', format: 'date-time' }
        }
      },
      WebhookEndpoint: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          business_id: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri' },
          secret_key: { type: 'string', example: 'whsec_98fbc...' },
          events_json: { type: 'array', items: { type: 'string' } },
          is_active: { type: 'boolean' }
        }
      }
    }
  },
  paths: {
    '/health': {
      get: {
        summary: 'System health check',
        responses: {
          200: { description: 'Service operational' }
        }
      }
    },
    '/auth/register': {
      post: {
        summary: 'Register user and optional business profile',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'full_name'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', format: 'password', minLength: 8 },
                  full_name: { type: 'string' },
                  phone: { type: 'string' },
                  business_name: { type: 'string' },
                  rc_number: { type: 'string' },
                  address: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          201: { description: 'User successfully registered' },
          400: { description: 'Validation error' },
          409: { description: 'Email already exists' }
        }
      }
    },
    '/auth/login': {
      post: {
        summary: 'Authenticate credentials and obtain JWT',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string' },
                  password: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Authentication successful with Bearer JWT' },
          401: { description: 'Invalid credentials' }
        }
      }
    },
    '/auth/me': {
      get: {
        summary: 'Get current user profile and business memberships',
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: 'Authenticated user profile' },
          401: { description: 'Unauthorized' }
        }
      }
    },
    '/auth/switch-business': {
      post: {
        summary: 'Switch tenant context and obtain updated JWT',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['business_id'],
                properties: { business_id: { type: 'string', format: 'uuid' } }
              }
            }
          }
        },
        responses: {
          200: { description: 'Switched business context' },
          403: { description: 'Forbidden: not a member' }
        }
      }
    },
    '/businesses/me': {
      get: {
        summary: 'Get current business profile',
        security: [{ BearerAuth: [] }],
        responses: { 200: { description: 'Business profile' } }
      },
      put: {
        summary: 'Update company details (Owner only)',
        security: [{ BearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, rc_number: { type: 'string' }, address: { type: 'string' } }
              }
            }
          }
        },
        responses: { 200: { description: 'Updated business profile' }, 403: { description: 'Forbidden: Owner only' } }
      }
    },
    '/businesses/members': {
      get: {
        summary: 'List team members of active business',
        security: [{ BearerAuth: [] }],
        responses: { 200: { description: 'List of members' } }
      },
      post: {
        summary: 'Invite staff or owner member to business',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: { email: { type: 'string' }, role: { type: 'string', enum: ['owner', 'staff'] }, full_name: { type: 'string' } }
              }
            }
          }
        },
        responses: { 201: { description: 'Member invited' }, 409: { description: 'Member already exists' } }
      }
    },
    '/deals': {
      post: {
        summary: 'Create draft deal and initial terms version',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'amount', 'terms_text'],
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  amount: { type: 'number' },
                  currency: { type: 'string', default: 'NGN' },
                  terms_text: { type: 'string' },
                  counterparty_business_id: { type: 'string', format: 'uuid' },
                  invited_email: { type: 'string', format: 'email' }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Deal created in draft status' } }
      },
      get: {
        summary: 'List deals for active business',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }
        ],
        responses: { 200: { description: 'Paginated deals list' } }
      }
    },
    '/deals/invitations/{token}/accept': {
      post: {
        summary: 'Counterparty accepts invitation to join deal',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Invitation accepted and business bound' } }
      }
    },
    '/deals/{dealId}': {
      get: {
        summary: 'Get complete deal details with versioning and acceptance status',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deal details' }, 403: { description: 'Forbidden: Tenant isolation' } }
      }
    },
    '/deals/{dealId}/terms': {
      put: {
        summary: 'Revise agreement terms (increments version and resets acceptances)',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['terms_text'], properties: { terms_text: { type: 'string' } } }
            }
          }
        },
        responses: { 200: { description: 'New version created, deal status set to awaiting_acceptance' } }
      }
    },
    '/deals/{dealId}/accept': {
      post: {
        summary: 'Record digital acceptance of matching version (auto-activates when both sign)',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Acceptance recorded' } }
      }
    },
    '/deals/{dealId}/activity': {
      get: {
        summary: 'Fetch immutable chronological audit timeline',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Audit trail log' } }
      }
    },
    '/deals/{dealId}/obligations': {
      get: {
        summary: 'List obligations with computed is_overdue flags',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'List of obligations' } }
      },
      post: {
        summary: 'Create obligation deliverable',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'type', 'due_date'],
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  type: { type: 'string', enum: ['payment', 'delivery', 'inspection', 'document', 'service'] },
                  responsible_business_id: { type: 'string', format: 'uuid' },
                  due_date: { type: 'string', format: 'date-time' }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Obligation created' } }
      }
    },
    '/deals/{dealId}/obligations/{obligationId}/status': {
      patch: {
        summary: 'Update obligation status (records completion_date when completed)',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'obligationId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['not_started', 'in_progress', 'submitted_for_review', 'completed', 'disputed'] } }
              }
            }
          }
        },
        responses: { 200: { description: 'Status updated' } }
      }
    },
    '/deals/{dealId}/obligations/{obligationId}/extend-deadline': {
      patch: {
        summary: 'Extend deadline while permanently preserving original_due_date',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'obligationId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['new_due_date'],
                properties: { new_due_date: { type: 'string', format: 'date-time' }, reason: { type: 'string' } }
              }
            }
          }
        },
        responses: { 200: { description: 'Deadline extended' } }
      }
    },
    '/deals/{dealId}/evidence': {
      get: {
        summary: 'List evidence files submitted for the deal',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Evidence files list' } }
      },
      post: {
        summary: 'Upload evidence file (PDF, PNG, JPG, DOCX <= 10MB)',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  obligation_id: { type: 'string', format: 'uuid' },
                  notes: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Evidence saved to pluggable storage' } }
      }
    },
    '/deals/{dealId}/evidence/{evidenceId}/download': {
      get: {
        summary: 'Download and stream evidence document (guarded by tenant isolation)',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'evidenceId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'Binary stream' }, 403: { description: 'Forbidden' } }
      }
    },
    '/deals/{dealId}/payments': {
      get: {
        summary: 'Return payment ledger financial summary and transactions',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Payment summary and list' } }
      },
      post: {
        summary: 'Record manual payment milestone entry',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reported_amount'],
                properties: {
                  expected_amount: { type: 'number' },
                  reported_amount: { type: 'number' },
                  currency: { type: 'string', default: 'NGN' },
                  reference_no: { type: 'string' },
                  paid_at: { type: 'string', format: 'date-time' },
                  obligation_id: { type: 'string', format: 'uuid' },
                  notes: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Payment recorded in reported status' } }
      }
    },
    '/deals/{dealId}/payments/{paymentId}/status': {
      patch: {
        summary: 'Recipient confirms or acknowledges received payment',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['acknowledged', 'confirmed'] } }
              }
            }
          }
        },
        responses: { 200: { description: 'Payment status updated' }, 403: { description: 'Forbidden: Recipient only' } }
      }
    },
    '/deals/{dealId}/deliveries': {
      get: {
        summary: 'List delivery history and waybills',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deliveries list' } }
      },
      post: {
        summary: 'Record delivery dispatch with item manifest',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['delivery_reference'],
                properties: {
                  delivery_reference: { type: 'string' },
                  dispatch_date: { type: 'string', format: 'date-time' },
                  obligation_id: { type: 'string', format: 'uuid' },
                  items_json: { type: 'array', items: { type: 'object' } },
                  notes: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Delivery recorded in dispatched status' } }
      }
    },
    '/deals/{dealId}/deliveries/{deliveryId}/status': {
      patch: {
        summary: 'Recipient acknowledges delivery receipt or logs discrepancies',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'deliveryId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['delivered', 'acknowledged_with_discrepancy', 'confirmed'] },
                  discrepancy_notes: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { 200: { description: 'Delivery status updated' } }
      }
    },
    '/deals/{dealId}/disputes': {
      get: {
        summary: 'List disputes filed against this deal',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'List of disputes' } }
      },
      post: {
        summary: 'Open a dispute (sets deal status to disputed)',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'dealId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['category', 'description'],
                properties: {
                  category: { type: 'string' },
                  description: { type: 'string' },
                  obligation_id: { type: 'string', format: 'uuid' },
                  evidence_id: { type: 'string', format: 'uuid' }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Dispute opened, deal status changed to disputed' } }
      }
    },
    '/deals/{dealId}/disputes/{disputeId}/response': {
      post: {
        summary: 'Submit response and proposed resolution terms',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'disputeId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['response_text'],
                properties: { response_text: { type: 'string' }, proposed_terms: { type: 'string' } }
              }
            }
          }
        },
        responses: { 200: { description: 'Response recorded' } }
      }
    },
    '/deals/{dealId}/disputes/{disputeId}/resolve': {
      post: {
        summary: 'Finalize resolution (reverts deal to active or completed/terminated)',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'dealId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'disputeId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['resolution_terms'],
                properties: {
                  resolution_terms: { type: 'string' },
                  resolution_action: { type: 'string', enum: ['resume_active', 'complete', 'terminate'], default: 'resume_active' }
                }
              }
            }
          }
        },
        responses: { 200: { description: 'Dispute resolved' } }
      }
    },
    '/webhooks': {
      get: {
        summary: 'List registered webhook endpoints for caller business',
        security: [{ BearerAuth: [] }],
        responses: { 200: { description: 'Webhook endpoints' } }
      },
      post: {
        summary: 'Register webhook endpoint with SSRF protection and shared secret',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          201: { description: 'Endpoint registered with secret_key' },
          400: { description: 'SSRF protection block or invalid URL' }
        }
      }
    },
    '/webhooks/{endpointId}/deliveries': {
      get: {
        summary: 'List delivery attempts and responses for endpoint',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Delivery history' } }
      }
    },
    '/webhooks/{endpointId}': {
      delete: {
        summary: 'Delete or deactivate webhook endpoint',
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'endpointId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Endpoint deleted' } }
      }
    },
    '/integrations/whatsapp/webhook': {
      get: {
        summary: 'Meta Cloud API Webhook Handshake Verification',
        tags: ['WhatsApp Integration'],
        parameters: [
          { name: 'hub.mode', in: 'query', required: true, schema: { type: 'string', example: 'subscribe' } },
          { name: 'hub.verify_token', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'hub.challenge', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Handshake accepted with challenge returned' },
          403: { description: 'Forbidden token mismatch' }
        }
      },
      post: {
        summary: 'Meta Cloud API Inbound Webhook Ingestion',
        tags: ['WhatsApp Integration'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          200: { description: 'Webhook acknowledged' }
        }
      }
    },
    '/integrations/whatsapp/mock-incoming': {
      post: {
        summary: 'Simulate Incoming WhatsApp Interaction (Local Testing & Dev Mode)',
        tags: ['WhatsApp Integration'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['from'],
                properties: {
                  from: { type: 'string', example: '2348011112222' },
                  text: { type: 'string', example: '/deal create' },
                  payload: { type: 'string', example: 'ACCEPT_DEAL_...' },
                  type: { type: 'string', example: 'text' }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Interaction processed and simulated replies returned' }
        }
      }
    },
    '/integrations/telegram/webhook': {
      post: {
        summary: 'Telegram Bot API Inbound Webhook',
        tags: ['Telegram Integration'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          200: { description: 'Telegram update processed' }
        }
      }
    },
    '/integrations/telegram/mock-incoming': {
      post: {
        summary: 'Simulate Incoming Telegram Message or Inline Callback',
        tags: ['Telegram Integration'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['chatId'],
                properties: {
                  chatId: { type: 'string', example: '11112222' },
                  text: { type: 'string', example: '/deals' },
                  callback_data: { type: 'string', example: 'ACCEPT_DEAL_...' },
                  photo: { type: 'object' }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Simulated replies and inline keyboards returned' }
        }
      }
    },
    '/integrations/email/actions/accept': {
      get: {
        summary: '1-Click Agreement Acceptance via Cryptographic Magic Token',
        tags: ['Email Integration'],
        parameters: [
          { name: 'token', in: 'query', required: true, schema: { type: 'string' }, description: 'HMAC-SHA256 signed action token' }
        ],
        responses: {
          200: { description: 'Rendered responsive HTML success page and agreement activated' },
          400: { description: 'Token invalid, expired, or tampered' }
        }
      }
    },
    '/integrations/email/actions/confirm-payment': {
      get: {
        summary: '1-Click Payment Confirmation via Cryptographic Magic Token',
        tags: ['Email Integration'],
        parameters: [
          { name: 'token', in: 'query', required: true, schema: { type: 'string' }, description: 'HMAC-SHA256 signed action token' }
        ],
        responses: {
          200: { description: 'Rendered responsive HTML confirmation page and payment confirmed' },
          400: { description: 'Token invalid, expired, or tampered' }
        }
      }
    },
    '/integrations/email/mock-inbox': {
      get: {
        summary: 'Inspect Simulated Mailbox History (Local Testing)',
        tags: ['Email Integration'],
        parameters: [
          { name: 'to', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter emails by recipient' }
        ],
        responses: {
          200: { description: 'List of captured transactional emails' }
        }
      }
    },
    '/integrations/email/mock-send': {
      post: {
        summary: 'Simulate Sending a Transactional Email with 1-Click Action Link',
        tags: ['Email Integration'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  to: { type: 'string', example: 'procurement@betabuilders.ng' },
                  subject: { type: 'string', example: 'Contract Invitation: #DW-8821' },
                  actionType: { type: 'string', enum: ['accept_deal', 'confirm_payment'] },
                  payload: { type: 'object' }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Simulated email queued in mock mailbox' }
        }
      }
    },
    '/integrations/email/mock-clear': {
      post: {
        summary: 'Clear Mock Mailbox History',
        tags: ['Email Integration'],
        responses: {
          200: { description: 'Mailbox cleared' }
        }
      }
    }
  }
};

export const swaggerOptions = {
  customSiteTitle: 'Digital Watchdog API Documentation',
  customCss: '.swagger-ui .topbar { display: none }',
  swaggerOptions: {
    persistAuthorization: true
  }
};
