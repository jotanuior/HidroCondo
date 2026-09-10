# Correção de reconciliação SCAE

A migration 011 garante que `account_members.is_owner` nunca receba `NULL` quando uma conta sincronizada do SCAE não possui `owner_user_id` definido.
